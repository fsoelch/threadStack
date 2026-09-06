---
name: xcode-project-format
description: ThreadStack.xcodeproj uses Xcode 16+ PBXFileSystemSynchronizedRootGroup — new Swift files need NO manual pbxproj entries
metadata:
  type: project
---

`ThreadStackApp/ThreadStack/ThreadStack.xcodeproj/project.pbxproj` uses the
modern Xcode 16+ "file system synchronized groups" format
(`PBXFileSystemSynchronizedRootGroup`, `objectVersion = 77`). The whole
`ThreadStack/` folder (main app target) and `ThreadStackTests/` folder (unit
test target) are each a single synchronized root group with no per-file
`PBXBuildFile`/`PBXFileReference`/`PBXSourcesBuildPhase` entries at all (grep
for `.swift` in the file returns nothing beyond comments).

**Why:** Xcode auto-discovers every file placed inside these folders and adds
it to the corresponding target automatically — there is no
`PBXFileSystemSynchronizedBuildFileExceptionSet`/`membershipExceptions` in
this project, so nothing is excluded either.

**How to apply:** When asked to "add file X to the Xcode target" (or a task
description assumes the old-style explicit pbxproj file list), first check
`project.pbxproj` for `PBXFileSystemSynchronizedRootGroup`. If present, do
**not** hand-add legacy `PBXBuildFile`/`PBXFileReference` entries — it's
unnecessary and would create dangling/invalid project objects since the
synchronized group has no `children` list to hook them into. Instead just
verify the new `.swift` file physically lives inside
`ThreadStackApp/ThreadStack/ThreadStack/` (app target) or
`ThreadStackApp/ThreadStack/ThreadStackTests/` (test target) — that's
sufficient. Confirm with `xcodebuild -scheme ThreadStack -destination
'generic/platform=iOS Simulator' build` (or a simulator destination for
running tests) since `xcodebuild`/Xcode.app are available in this
environment. Test files use the Swift `Testing` framework (`import Testing`,
`@Test`, `struct ... Tests`), not XCTest — `-only-testing:` filters must
reference an actual `struct` name declared in the file, not the file name
itself (a whole file can contain several independent test structs).
