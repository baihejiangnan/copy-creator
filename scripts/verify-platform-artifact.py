"""Verify downloaded validation artifacts without launching Copy Creator."""
import argparse
import hashlib
import json
import pathlib
import re


def verify(root, source, target):
    root = root.resolve(strict=True)
    if not re.fullmatch(r"[0-9a-f]{40}", source):
        raise ValueError("Invalid expected source SHA")
    expected_suffixes = {
        "aarch64-apple-darwin": {".dmg": 1},
        "x86_64-apple-darwin": {".dmg": 1},
        "x86_64-unknown-linux-gnu": {".deb": 1, ".AppImage": 1},
    }[target]
    if (root / "SOURCE_COMMIT.txt").read_text().strip() != source:
        raise ValueError("Source SHA mismatch")
    info = (root / "BUILD_INFO.txt").read_text().splitlines()
    if "validationOnly=true" not in info or f"target={target}" not in info:
        raise ValueError("Validation mode or target mismatch")
    packages = []
    listed = set()
    counts = dict.fromkeys(expected_suffixes, 0)
    for line in (root / "SHA256SUMS.txt").read_text().splitlines():
        match = re.fullmatch(r"([0-9a-fA-F]{64})  (\./[^\r\n]+)", line)
        if not match:
            raise ValueError("Invalid checksum entry")
        digest, name = match.groups()
        relative = pathlib.PurePosixPath(name[2:])
        if relative.is_absolute() or ".." in relative.parts or "\\" in name:
            raise ValueError("Unsafe checksum path")
        if relative.suffix not in counts or relative.as_posix() in listed:
            raise ValueError("Unexpected or duplicate package")
        package = root.joinpath(*relative.parts)
        if package.is_symlink() or not package.resolve(strict=True).is_relative_to(root):
            raise ValueError("Package escapes artifact directory")
        actual = hashlib.sha256()
        with package.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                actual.update(chunk)
        if actual.hexdigest() != digest.lower() or package.stat().st_size == 0:
            raise ValueError("Package checksum or size mismatch")
        counts[relative.suffix] += 1
        listed.add(relative.as_posix())
        packages.append({"path": relative.as_posix(), "bytes": package.stat().st_size,
                         "sha256": actual.hexdigest()})
    if counts != expected_suffixes:
        raise ValueError("Missing or extra package types")
    allowed = listed | {"SOURCE_COMMIT.txt", "BUILD_INFO.txt", "SHA256SUMS.txt"}
    for file in root.rglob("*"):
        if file.is_symlink() or (file.is_file() and file.relative_to(root).as_posix() not in allowed):
            raise ValueError("Unexpected artifact file or symlink")
    return {"validationOnly": True, "sourceCommit": source, "target": target,
            "packages": packages}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=pathlib.Path)
    parser.add_argument("source")
    parser.add_argument("target")
    args = parser.parse_args()
    print(json.dumps(verify(args.directory, args.source, args.target), indent=2))
