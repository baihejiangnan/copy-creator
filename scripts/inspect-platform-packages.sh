#!/usr/bin/env bash
# Read package structures in an ephemeral runner. Never launch the application.
set -euo pipefail
package_root=$(cd "$1" && pwd)
target=$2
version=$3
work=$(mktemp -d "${RUNNER_TEMP:?}/package-inspect.XXXXXX")

case "$target" in
  aarch64-apple-darwin|x86_64-apple-darwin)
    dmg=("$package_root"/dmg/*.dmg)
    hdiutil verify "${dmg[0]}"
    mount="$work/mount"
    mkdir "$mount"
    hdiutil attach -readonly -nobrowse -mountpoint "$mount" "${dmg[0]}"
    trap 'hdiutil detach "$mount"' EXIT
    apps=("$mount"/*.app)
    test "${#apps[@]}" -eq 1
    app=${apps[0]}
    plist="$app/Contents/Info.plist"
    plutil -lint "$plist"
    test "$(plutil -extract CFBundleIdentifier raw "$plist")" = com.copycreator.app
    test "$(plutil -extract CFBundleShortVersionString raw "$plist")" = "$version"
    executable=$(plutil -extract CFBundleExecutable raw "$plist")
    case "$executable" in ''|*/*|.|..) exit 1;; esac
    binary="$app/Contents/MacOS/$executable"
    test -x "$binary"
    architecture=$(lipo -archs "$binary")
    if [[ "$target" == aarch64-* ]]; then test "$architecture" = arm64;
    else test "$architecture" = x86_64; fi
    icon=$(plutil -extract CFBundleIconFile raw "$plist")
    case "$icon" in ''|*/*|.|..) exit 1;; esac
    test -s "$app/Contents/Resources/$icon" || test -s "$app/Contents/Resources/$icon.icns"
    test -L "$mount/Applications"
    test "$(readlink "$mount/Applications")" = /Applications
    codesign --verify --deep --strict --verbose=2 "$app"
    codesign -d --verbose=4 "$app" 2> "$work/signature.txt"
    cat "$work/signature.txt"
    grep -q 'Signature=adhoc' "$work/signature.txt"
    plutil -p "$plist"
    otool -L "$binary"
    printf 'DMG verified; architecture=%s; ad-hoc only; notarization/Gatekeeper acceptance not tested\n' "$architecture"
    ;;
  x86_64-unknown-linux-gnu)
    deb=("$package_root"/deb/*.deb)
    test "$(dpkg-deb -f "${deb[0]}" Architecture)" = amd64
    test "$(dpkg-deb -f "${deb[0]}" Version)" = "$version"
    depends=$(dpkg-deb -f "${deb[0]}" Depends)
    printf 'DEB dependencies: %s\n' "$depends"
    grep -q 'libwebkit2gtk-4.1-0' <<< "$depends"
    grep -q 'libgtk-3-0' <<< "$depends"
    dpkg-deb --info "${deb[0]}"
    dpkg-deb --extract "${deb[0]}" "$work/deb"
    test -x "$work/deb/usr/bin/copy-creator"
    readelf -h "$work/deb/usr/bin/copy-creator" | grep 'Advanced Micro Devices X86-64'
    readelf -d "$work/deb/usr/bin/copy-creator" | grep NEEDED
    desktop="$work/deb/usr/share/applications/Copy Creator.desktop"
    if [[ ! -f "$desktop" ]]; then desktop="$work/deb/usr/share/applications/copy-creator.desktop"; fi
    desktop-file-validate "$desktop"
    grep -Eq '^Exec=copy-creator( |$)' "$desktop"
    grep -Eq '^Icon=copy-creator$' "$desktop"
    test -n "$(find "$work/deb/usr/share/icons" -type f -name 'copy-creator.png' -print -quit)"
    appimage=("$package_root"/appimage/*.AppImage)
    # GitHub's artifact ZIP removes outer execute permissions. Downloaded
    # AppImages need chmod +x; internal SquashFS modes must remain intact.
    chmod u+x "${appimage[0]}"
    cd "$work"
    timeout 120 "${appimage[0]}" --appimage-extract > "$work/extract.txt"
    test -x squashfs-root/AppRun
    test -x squashfs-root/usr/bin/copy-creator
    readelf -h squashfs-root/usr/bin/copy-creator | grep 'Advanced Micro Devices X86-64'
    test -s squashfs-root/.DirIcon
    desktops=(squashfs-root/*.desktop)
    test "${#desktops[@]}" -eq 1
    desktop-file-validate "${desktops[0]}"
    printf 'DEB and AppImage structure verified; no installation or application launch; FUSE runtime not tested\n'
    ;;
  *) exit 1;;
esac
