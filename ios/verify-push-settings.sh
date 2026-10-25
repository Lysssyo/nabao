#!/bin/sh
set -eu
task_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
task_build=$(mktemp -d "${TMPDIR:-/tmp}/nabao-push-settings.XXXXXX")
trap 'rm -rf "$task_build"' EXIT HUP INT TERM
if [ -d /Applications/Xcode.app/Contents/Developer ]; then
    export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi
xcrun swiftc -parse-as-library -emit-library -emit-module -module-name NabaoCore \
    "$task_root"/ios/NabaoCore/Sources/NabaoCore/*.swift \
    -emit-module-path "$task_build/NabaoCore.swiftmodule" -o "$task_build/libNabaoCore.dylib"
xcrun swiftc -parse-as-library -I "$task_build" -L "$task_build" -lNabaoCore \
    -Xlinker -rpath -Xlinker "$task_build" \
    "$task_root/ios/App/Services/RemotePushStore.swift" "$task_root/ios/Tests/RemotePushSettingsChecks.swift" \
    -o "$task_build/verify-push-settings"
"$task_build/verify-push-settings"
