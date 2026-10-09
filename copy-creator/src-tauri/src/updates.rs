use reqwest::StatusCode;
use semver::Version;
use serde::{Deserialize, Serialize};
use std::time::Duration;

const REPOSITORY: &str = "https://github.com/baihejiangnan/copy-creator";
const RELEASE_API: &str = "https://api.github.com/repos/baihejiangnan/copy-creator/releases/latest";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    name: String,
    version: String,
    author: &'static str,
    license: &'static str,
    repository_url: &'static str,
    upstream_url: &'static str,
    releases_url: String,
}

#[tauri::command]
pub fn get_app_info(app: tauri::AppHandle) -> AppInfo {
    AppInfo {
        name: "Copy Creator".into(),
        version: app.package_info().version.to_string(),
        author: "baihejiangnan",
        license: "MIT",
        repository_url: REPOSITORY,
        upstream_url: "https://github.com/hu-qi-jia/copy-creator",
        releases_url: format!("{REPOSITORY}/releases"),
    }
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    html_url: String,
    #[serde(default)]
    body: Option<String>,
    draft: bool,
    prerelease: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResult {
    status: &'static str,
    latest_version: Option<String>,
    release_url: Option<String>,
    notes: Option<String>,
}

fn evaluate_release(current: &Version, release: Release) -> Result<UpdateResult, String> {
    let latest = Version::parse(release.tag_name.trim().trim_start_matches(['v', 'V']))
        .map_err(|_| "updates.invalidRelease")?;
    let url = reqwest::Url::parse(&release.html_url).map_err(|_| "updates.invalidRelease")?;
    if release.draft
        || release.prerelease
        || url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || !url
            .path()
            .starts_with("/baihejiangnan/copy-creator/releases/tag/")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return Err("updates.invalidRelease".into());
    }
    Ok(UpdateResult {
        // Build metadata does not affect semantic version precedence.
        status: if latest.cmp_precedence(current).is_gt() {
            "available"
        } else {
            "upToDate"
        },
        latest_version: Some(latest.to_string()),
        release_url: Some(release.html_url),
        notes: release.body.filter(|notes| !notes.trim().is_empty()),
    })
}

#[tauri::command]
pub async fn check_for_updates(app: tauri::AppHandle) -> Result<UpdateResult, String> {
    let client = reqwest::Client::builder()
        .user_agent(format!("Copy-Creator/{}", app.package_info().version))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "updates.networkError")?;
    let response = client
        .get(RELEASE_API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|_| "updates.networkError")?;
    match response.status() {
        StatusCode::NOT_FOUND => {
            return Ok(UpdateResult {
                status: "noRelease",
                latest_version: None,
                release_url: None,
                notes: None,
            })
        }
        StatusCode::FORBIDDEN | StatusCode::TOO_MANY_REQUESTS => {
            return Err("updates.rateLimited".into());
        }
        status if !status.is_success() => return Err("updates.serverError".into()),
        _ => {}
    }
    let release = response
        .json::<Release>()
        .await
        .map_err(|_| "updates.invalidRelease")?;
    evaluate_release(&app.package_info().version, release)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str) -> Release {
        Release {
            tag_name: tag.into(),
            html_url: format!("{REPOSITORY}/releases/tag/{tag}"),
            body: Some("Release notes".into()),
            draft: false,
            prerelease: false,
        }
    }

    #[test]
    fn compares_semantic_versions_without_downgrading() {
        let current = Version::parse("0.2.24").unwrap();
        for (tag, expected) in [
            ("v0.2.25", "available"),
            ("v0.10.0", "available"),
            ("v0.2.24", "upToDate"),
            ("v0.2.9", "upToDate"),
            ("v0.2.24+build.2", "upToDate"),
            ("v0.2.24-baihejiangnan.1", "upToDate"),
            ("v0.2.25-baihejiangnan.1", "available"),
        ] {
            assert_eq!(
                evaluate_release(&current, release(tag)).unwrap().status,
                expected
            );
        }
        let preview = Version::parse("0.3.0-beta.1").unwrap();
        let installed = Version::parse("0.2.25").unwrap();
        assert_eq!(
            evaluate_release(&installed, release("v0.2.25-baihejiangnan.1")).unwrap().status,
            "upToDate"
        );
        assert_eq!(
            evaluate_release(&preview, release("v0.3.0"))
                .unwrap()
                .status,
            "available"
        );
    }

    #[test]
    fn rejects_malformed_previews_and_untrusted_links() {
        let current = Version::parse("0.2.24").unwrap();
        for tag in ["latest", "v0.3"] {
            assert!(evaluate_release(&current, release(tag)).is_err());
        }
        for url in [
            "https://example.com/baihejiangnan/copy-creator/releases/tag/v0.3.0",
            "http://github.com/baihejiangnan/copy-creator/releases/tag/v0.3.0",
            "https://github.com/hu-qi-jia/copy-creator/releases/tag/v0.3.0",
        ] {
            let mut invalid = release("v0.3.0");
            invalid.html_url = url.into();
            assert!(evaluate_release(&current, invalid).is_err());
        }
        let mut draft = release("v0.3.0");
        draft.draft = true;
        assert!(evaluate_release(&current, draft).is_err());
        let mut preview = release("v0.3.0");
        preview.prerelease = true;
        assert!(evaluate_release(&current, preview).is_err());
    }
}
