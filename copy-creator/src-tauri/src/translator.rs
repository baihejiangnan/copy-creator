use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Debug, Serialize, Deserialize)]
pub struct TranslateResponse {
    pub source_text: String,
    pub target_text: String,
    pub engine: String,
}

#[tauri::command]
pub async fn translate(
    app: tauri::AppHandle,
    text: String,
    target_lang: String,
    expected_storage_epoch: Option<u64>,
) -> Result<TranslateResponse, String> {
    let source_lang = "auto".to_string();

    let state = app.state::<crate::db::DbState>();
    let (engine, storage_epoch) = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        crate::lifecycle::allow_write(&app)?;
        crate::db::require_storage_epoch(&app, expected_storage_epoch)?;
        let engine = conn.query_row(
            "SELECT value FROM settings WHERE key = 'default_translate_engine'",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_else(|_| "google".to_string());
        (engine, state.storage_epoch.load(std::sync::atomic::Ordering::Relaxed))
    };

    // Check cache
    {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        crate::db::require_storage_epoch(&app, Some(storage_epoch))?;
        let cached: Option<String> = conn
            .query_row(
                "SELECT target_text FROM translation_history WHERE source_text = ?1 AND target_lang = ?2 AND engine = ?3 ORDER BY created_at DESC LIMIT 1",
                rusqlite::params![text, target_lang, engine],
                |row| row.get(0),
            )
            .ok();
        if let Some(cached_text) = cached {
            return Ok(TranslateResponse {
                source_text: text,
                target_text: cached_text,
                engine,
            });
        }
    }

    let result = if engine == "ai" {
        translate_ai(&app, &text, &source_lang, &target_lang, storage_epoch).await?
    } else {
        translate_google(&app, &text, &source_lang, &target_lang, storage_epoch).await?
    };

    // Save to history/cache
    {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        crate::lifecycle::allow_write(&app)?;
        if storage_epoch != state.storage_epoch.load(std::sync::atomic::Ordering::Relaxed) { return Err("notes.storageChanged".into()); }
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO translation_history (id, source_text, target_text, source_lang, target_lang, engine, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![id, text, result.target_text, source_lang, target_lang, engine, &now],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(result)
}

async fn translate_ai(
    app: &tauri::AppHandle,
    text: &str,
    source_lang: &str,
    target_lang: &str,
    storage_epoch: u64,
) -> Result<TranslateResponse, String> {
    let state = app.state::<crate::db::DbState>();
    let (api_url, api_key, model) = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        crate::db::require_storage_epoch(app, Some(storage_epoch))?;
        let url: String = conn.query_row(
            "SELECT value FROM settings WHERE key = 'ai_api_url'", [], |r| r.get(0),
        ).unwrap_or_default();
        let key: String = conn.query_row(
            "SELECT value FROM settings WHERE key = 'ai_api_key'", [], |r| r.get(0),
        ).unwrap_or_default();
        let m: String = conn.query_row(
            "SELECT value FROM settings WHERE key = 'ai_model'", [], |r| r.get(0),
        ).unwrap_or_else(|_| "gpt-3.5-turbo".to_string());
        (url, crate::secrets::reveal(&key)?, m)
    };

    if api_url.is_empty() || api_key.is_empty() {
        return Err("AI 翻译未配置，请在设置中填写 API 地址和 Key".to_string());
    }

    let full_url = if api_url.contains("/chat/completions") || api_url.contains("/completions") {
        api_url.clone()
    } else {
        let base = api_url.trim_end_matches('/');
        format!("{}/v1/chat/completions", base)
    };

    let prompt = format!(
        "Translate the following text from {source} to {target}. Only output the translated text, nothing else.\n\nText: {text}",
        source = if source_lang == "auto" { "auto-detected language" } else { source_lang },
        target = target_lang,
        text = text
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let resp = client
        .post(&full_url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({
            "model": model,
            "messages": [
                {"role": "system", "content": "You are a professional translator. Only output the translated text."},
                {"role": "user", "content": prompt}
            ],
            "temperature": 0.3
        }))
        .send().await.map_err(|e| format!("AI 翻译请求失败: {}", e))?;

    let status = resp.status();
    let body_text = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;

    if !status.is_success() {
        return Err(format!("AI 翻译 HTTP {}: {}", status.as_u16(), truncate_chars(&body_text, 80)));
    }

    let json: serde_json::Value = serde_json::from_str(&body_text)
        .map_err(|e| format!("解析响应失败: {}", e))?;

    let translated = json["choices"][0]["message"]["content"]
        .as_str()
        .ok_or("AI 响应格式异常，未找到 choices[0].message.content")?
        .trim()
        .to_string();

    Ok(TranslateResponse {
        source_text: text.to_string(),
        target_text: translated,
        engine: "ai".to_string(),
    })
}

async fn translate_google(
    app: &tauri::AppHandle,
    text: &str,
    _source_lang: &str,
    target_lang: &str,
    storage_epoch: u64,
) -> Result<TranslateResponse, String> {
    let state = app.state::<crate::db::DbState>();
    let (api_key, proxy_url): (String, String) = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        crate::db::require_storage_epoch(app, Some(storage_epoch))?;
        let key: String = conn.query_row(
            "SELECT value FROM settings WHERE key = 'google_api_key'", [], |r| r.get(0),
        ).unwrap_or_default();
        let proxy: String = conn.query_row(
            "SELECT value FROM settings WHERE key = 'translate_proxy'", [], |r| r.get(0),
        ).unwrap_or_default();
        (crate::secrets::reveal(&key)?, proxy)
    };

    let mut builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15));

    if !proxy_url.is_empty() {
        let proxy = reqwest::Proxy::all(&proxy_url)
            .map_err(|e| format!("代理配置无效 ({}): {}", proxy_url, e))?;
        builder = builder.proxy(proxy);
    }

    let client = builder
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    if api_key.is_empty() {
        let resp = client
            .get("https://translate.googleapis.com/translate_a/single")
            .query(&[
                ("client", "gtx"),
                ("sl", "auto"),
                ("tl", target_lang),
                ("dt", "t"),
                ("q", text),
            ])
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
            .send().await.map_err(|e| fmt_reqwest_error(&e))?;

        let status = resp.status();
        let body = resp.text().await.map_err(|e| format!("读取 Google 响应失败: {}", e))?;

        if !status.is_success() {
            return Err(format!("Google 翻译 HTTP {}: {}", status.as_u16(), truncate_chars(&body, 80)));
        }

        let json: serde_json::Value = serde_json::from_str(&body)
            .map_err(|e| format!("解析 Google 响应失败: {}", e))?;

        let translated = json[0][0][0]
            .as_str()
            .unwrap_or("翻译失败")
            .to_string();

        return Ok(TranslateResponse {
            source_text: text.to_string(),
            target_text: translated,
            engine: "google".to_string(),
        });
    }

    let resp = client
        .post("https://translation.googleapis.com/language/translate/v2")
        .query(&[("key", api_key.as_str())])
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
        .json(&serde_json::json!({
            "q": text,
            "target": target_lang,
            "format": "text"
        }))
        .send().await.map_err(|e| fmt_reqwest_error(&e))?;

    let json: serde_json::Value = resp.json().await
        .map_err(|e| format!("解析 Google 响应失败: {}", e))?;

    if let Some(error) = json.get("error") {
        let msg = error["message"].as_str().unwrap_or("未知错误");
        return Err(format!("Google 翻译错误: {}", truncate_chars(msg, 80)));
    }

    let translated = json["data"]["translations"][0]["translatedText"]
        .as_str()
        .unwrap_or("翻译失败")
        .to_string();

    Ok(TranslateResponse {
        source_text: text.to_string(),
        target_text: translated,
        engine: "google".to_string(),
    })
}

/// 截断错误响应正文用于提示。按**字符**而非字节截断：响应可能包含任意
/// Unicode（中文错误说明、emoji），按字节切片会落在字符中间并 panic。
fn truncate_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn fmt_reqwest_error(err: &reqwest::Error) -> String {
    if err.is_connect() {
        "Google 翻译连接失败，请检查代理配置".to_string()
    } else if err.is_timeout() {
        "Google 翻译请求超时".to_string()
    } else {
        format!("Google 翻译请求失败: {}", err)
    }
}

#[cfg(test)]
mod tests {
    use super::truncate_chars;

    #[test]
    fn truncate_chars_never_splits_a_multibyte_character() {
        // 90 字节 / 30 字符：按字节切第 80 字节会落在字符中间并 panic。
        let chinese = "一".repeat(30);
        let out = truncate_chars(&chinese, 80);
        assert_eq!(out.chars().count(), 30);
        assert_eq!(out, chinese);

        let out = truncate_chars(&chinese, 10);
        assert_eq!(out.chars().count(), 10);
        assert_eq!(out, "一".repeat(10));
    }

    #[test]
    fn truncate_chars_counts_characters_not_bytes() {
        // 每个 emoji 是 4 字节，12 个 emoji 共 48 字节。
        let emoji = "🔑".repeat(12);
        assert_eq!(emoji.len(), 48);
        let out = truncate_chars(&emoji, 5);
        assert_eq!(out.chars().count(), 5);
        assert_eq!(out, "🔑".repeat(5));
    }

    #[test]
    fn truncate_chars_keeps_ascii_behaviour_byte_identical() {
        let ascii = "a".repeat(200);
        assert_eq!(truncate_chars(&ascii, 80), "a".repeat(80));

        // 恰好等于上限时不截断。
        assert_eq!(truncate_chars(&ascii, 200), ascii);

        // 空串与短串原样返回。
        assert_eq!(truncate_chars("", 80), "");
        assert_eq!(truncate_chars("short", 80), "short");
    }

    #[test]
    fn truncate_chars_handles_mixed_width_text() {
        // 41 组「中文」= 82 字符 / 246 字节，后面再跟 ASCII。
        // 按字节切第 80 字节会落在某个汉字中间（80 / 3 不整除）。
        let mixed = format!("{}sk-abc", "中文".repeat(41));
        assert_eq!(mixed.chars().count(), 88);
        assert_eq!(mixed.len(), 252);

        let out = truncate_chars(&mixed, 80);
        assert_eq!(out.chars().count(), 80);
        assert_eq!(out, "中文".repeat(40));
        // 截断后仍是合法 UTF-8（能按字符重组即证明未落在字符中间）。
        assert_eq!(out.chars().collect::<String>(), out);
    }
}

