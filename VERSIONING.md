# Versioning

Flatform's version is `package.json` → `version`. Everything else (the title bar, Settings → About, the update
check, the installer name) reads it from there.

- Releases step by 0.1: 1.1, 1.2 … 1.9, then 2.0, 2.1 … There is no 1.10.
- Written as semver `X.Y.0` (`1.2.0`). The app shows it short: "Version 1.2".
- There are no patch numbers: every release, fixes included, is the next `X.Y.0`.
- Each release gets a tag `vX.Y.0` (`v1.2.0`). Pushing the tag builds Windows and Mac into a draft GitHub release;
  the build stops if the tag and `package.json` disagree.
- The Windows installer is `Flatform-Setup-X.Y.0.exe`.
- Every release gets an entry at the top of [CHANGELOG.md](CHANGELOG.md).

Before 1.1 the app was numbered 0.x (last: 0.5.0). The update check compares versions in semver order, so 1.1.0
is newer than any 0.x and 2.0.0 is newer than 1.9.0.

To release: set the version in `package.json` (and run `npm install` so `package-lock.json` follows), add the
CHANGELOG entry, commit, then tag `vX.Y.0` and push the tag.
