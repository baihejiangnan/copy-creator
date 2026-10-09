use serde::Serialize;
use std::io::{self, Write};
use zeroize::Zeroizing;

struct Counter {
    count: usize,
    maximum: usize,
    exceeded: bool,
}
impl Write for Counter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.maximum.saturating_sub(self.count) {
            self.exceeded = true;
            return Err(io::Error::other("backup.fileTooLarge"));
        }
        self.count += bytes.len();
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
pub(crate) fn serialized_size(value: &impl Serialize, maximum: usize) -> Result<usize, String> {
    let mut writer = Counter {
        count: 0,
        maximum,
        exceeded: false,
    };
    let result = serde_json::to_writer(&mut writer, value);
    if writer.exceeded {
        return Err("backup.fileTooLarge".into());
    }
    result.map_err(|_| "backup.invalidFile")?;
    Ok(writer.count)
}
struct BoundedVec {
    bytes: Zeroizing<Vec<u8>>,
    maximum: usize,
    exceeded: bool,
}
impl Write for BoundedVec {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.maximum.saturating_sub(self.bytes.len()) {
            self.exceeded = true;
            return Err(io::Error::other("backup.fileTooLarge"));
        }
        let needed = self.bytes.len() + bytes.len();
        if needed > self.bytes.capacity() {
            let capacity = needed
                .max(self.bytes.capacity().saturating_mul(2))
                .min(self.maximum);
            let extra = capacity - self.bytes.len();
            self.bytes
                .try_reserve_exact(extra)
                .map_err(|_| io::Error::other("backup.fileTooLarge"))?;
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
pub(crate) fn encode_json(
    value: &impl Serialize,
    maximum: usize,
    pretty: bool,
) -> Result<Zeroizing<Vec<u8>>, String> {
    let mut writer = BoundedVec {
        bytes: Zeroizing::new(Vec::new()),
        maximum,
        exceeded: false,
    };
    let result = if pretty {
        serde_json::to_writer_pretty(&mut writer, value)
    } else {
        serde_json::to_writer(&mut writer, value)
    };
    if writer.exceeded {
        return Err("backup.fileTooLarge".into());
    }
    result.map_err(|_| "backup.invalidFile")?;
    Ok(writer.bytes)
}
pub(crate) struct Budget {
    remaining: usize,
}
impl Budget {
    pub fn new(maximum: usize) -> Self {
        Self { remaining: maximum }
    }
    pub fn include(&mut self, value: &impl Serialize) -> Result<(), String> {
        let size = serialized_size(value, self.remaining)?;
        self.remaining = self
            .remaining
            .checked_sub(size.saturating_add(1))
            .ok_or("backup.fileTooLarge")?;
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn escaped_json_obeys_exact_boundary_and_capacity_without_a_full_failed_allocation() {
        let value = "\n\"中文\\";
        let expected = serde_json::to_vec(value).unwrap();
        let actual = encode_json(&value, expected.len(), false).unwrap();
        assert_eq!(*actual, expected);
        assert!(actual.capacity() <= expected.len());
        assert_eq!(
            encode_json(&value, expected.len() - 1, false).unwrap_err(),
            "backup.fileTooLarge"
        );
        assert_eq!(
            serialized_size(&value, expected.len()).unwrap(),
            expected.len()
        );
        assert!(serialized_size(&value, expected.len() - 1).is_err());
    }
    #[test]
    fn incremental_budget_refuses_the_next_item_before_retaining_it() {
        let mut budget = Budget::new(10);
        budget.include(&"123").unwrap();
        assert!(budget.include(&"456").is_err());
    }
}
