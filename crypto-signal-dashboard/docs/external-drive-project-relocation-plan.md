# BremBot External-Drive Relocation Plan

## Migration Completion Update — July 23, 2026

The migration described below has been completed with an APFS sparse bundle on
the physical exFAT drive. The remaining sections are retained as the original
planning and acceptance record.

The active locations are:

```text
Physical image: /Volumes/1TB/BremLogicBuild.sparsebundle
Mounted APFS volume: /Volumes/BremLogicBuild
Active repository: /Volumes/BremLogicBuild/BremBot
Backtest data: /Volumes/1TB/BremLogicStorage/backtest/data
Backtest results: /Volumes/1TB/BremLogicStorage/backtest/results
Internal-branch archive: /Volumes/1TB/BremLogicStorage/migration-archive/BremBot-internal-branches-20260723.bundle
```

Dependencies, npm cache, Next.js output, Swift package clones, and Xcode
DerivedData are stored on the external drive. Web tests, the production build,
signed iPhone/Watch builds, signed Mac/widget builds, GitHub pushes, and Vercel
deployments have succeeded from this layout.

The sparse bundle must be mounted at `/Volumes/BremLogicBuild` before opening
the project. Xcode GUI builds must use an external DerivedData location to avoid
recreating build output internally. GitHub and hosted Vercel deployments do not
depend on the local filesystem path.

## Status

Completed using the locations recorded above.

## Objective

Relocate the complete BremBot folder from the Mac's internal storage to the connected 1 TB external drive while preserving:

- Every regular file and its contents
- The complete `.git` repository and history
- Uncommitted and untracked work
- Symbolic links
- Executable permission bits
- macOS extended attributes and metadata where applicable
- Xcode project behavior
- Node/package tooling
- GitHub connectivity
- Vercel project linkage
- Existing backtest datasets and results

The internal source copy must not be removed until the external copy passes all integrity and functional checks.

## Current Blocker

The external drive is currently mounted as:

```text
/Volumes/1TB
```

Its current filesystem is **exFAT**. A direct whole-project move onto exFAT is not considered safe because exFAT does not fully preserve the filesystem behavior required by this project, including:

- Unix symbolic links
- Executable permission bits and ownership semantics
- Some macOS extended attributes and flags
- Reliable representation of the tracked Xcode symlink
- The numerous symlinks used inside `node_modules`

The earlier backtest-storage relocation already demonstrated this limitation when exFAT rejected macOS `chflags` metadata.

## Recommended Storage Configuration

Use a native **APFS** volume for the project. APFS Encrypted can be used if encryption is desired.

If the drive must remain readable by Windows, divide it into two partitions or volumes:

1. An APFS volume dedicated to BremBot and other Mac development projects.
2. An exFAT volume for files that need Windows compatibility.

Reformatting or repartitioning can erase data. The external drive's existing contents must be copied to a separate verified location before changing its filesystem.

An APFS sparse bundle stored on the exFAT volume could avoid reformatting, but it is not the preferred permanent solution. It introduces an additional mount dependency and makes the disk image another potential failure point.

## Proposed Migration Procedure

### 1. Prepare and back up

- Stop development servers, builds, Xcode, Git operations, and backtests.
- Inventory the external drive's existing contents.
- Copy those contents to a separate temporary or backup location.
- Verify the backup before modifying the external drive.
- Record the current Git branch, HEAD commit, remotes, status, submodules, symlinks, file modes, and local configuration.
- Generate a SHA-256 manifest of the complete internal BremBot tree.

### 2. Prepare the external volume

- Format the intended project volume as APFS or APFS Encrypted.
- Give it a unique, stable name rather than the generic `1TB` name. A possible name is `BremLogic`.
- Confirm that the mount point is stable and that macOS can create symlinks, preserve executable bits, and store extended attributes on it.
- Restore any previously backed-up external-drive contents to the appropriate volume.

### 3. Copy without deleting the source

- Copy the complete `/Users/lyrastudio/Documents/BremBot` directory using a macOS metadata-preserving method.
- Do not use a basic exFAT-style copy.
- Keep the original internal folder untouched during all verification.
- Suggested destination:

```text
/Volumes/BremLogic/Projects/BremBot
```

### 4. Verify byte and filesystem integrity

- Compare SHA-256 hashes for every regular source and destination file.
- Confirm identical file counts and relative paths.
- Compare every symbolic-link target.
- Compare executable permission bits.
- Compare extended attributes where required.
- Run `git fsck --full` in the external copy.
- Confirm the same branch, HEAD commit, remotes, Git status, untracked files, and staged changes.
- Confirm that the `.git` object database is intact.

### 5. Verify development behavior

- Run the project test suite from the external location.
- Run the production Next.js build.
- Verify package executables and native dependencies.
- Open and build the iOS project in Xcode.
- Verify the tracked Xcode symlink.
- Verify widget, watch, and native-app targets.
- Run a representative backtest using the externally stored data and results.
- Confirm normal read/write performance and behavior after Mac sleep and restart.

### 6. Verify external connections

- Confirm the Git remote remains:

```text
git@github.com:brownempire/BremBot.git
```

- Test a non-mutating Git fetch and confirm SSH authentication.
- Confirm the local Vercel project link and project identifiers.
- Confirm GitHub and Vercel still identify the correct repository and production project.
- Search for scripts, shell aliases, launch agents, Xcode references, Codex workspaces, and other tools containing the old absolute path.
- Update those references to the external location as needed.

GitHub and Vercel are primarily linked through repository and project identifiers, so changing the local filesystem path should not inherently disconnect either service.

### 7. Compatibility period

- Open future development sessions from the external repository.
- Optionally place a small compatibility symlink at the old internal location:

```text
/Users/lyrastudio/Documents/BremBot -> /Volumes/BremLogic/Projects/BremBot
```

- Keep the original internal source copy temporarily until repeated builds, Git operations, Xcode use, and a restart have succeeded.
- Do not maintain two writable repository copies long term, because they can diverge.

### 8. Final removal

- Generate one final source/destination verification report.
- Confirm that the external drive is mounted and backed up.
- Obtain explicit approval before deleting the internal copy.
- Remove the internal data only after all integrity and functional gates pass.
- Retain the compatibility symlink if any tooling still expects the old path.

## Acceptance Gates

The internal source must not be removed unless all of these pass:

- Every regular-file SHA-256 hash matches.
- File counts and relative paths match.
- All symlink targets match and resolve correctly.
- Required executable permissions and macOS metadata are preserved.
- `git fsck --full` reports no repository corruption.
- Branch, HEAD, remotes, staged changes, unstaged changes, and untracked files match.
- Tests and production build pass from the external location.
- Xcode opens and builds the intended targets.
- GitHub SSH/fetch works.
- Vercel linkage points to the existing production project.
- Backtest data and result paths work.
- The external volume remounts at the expected path after restart.
- A separate backup exists.

## Operational Considerations

- The external drive must be mounted before opening BremBot or running its services.
- Unexpected unplugging during Git writes, builds, database writes, or package installation can corrupt active work.
- A unique volume name reduces the chance that macOS mounts it under a changed path such as `/Volumes/1TB 1`.
- APFS is the appropriate filesystem for a Mac-hosted Git, Node, and Xcode workspace.
- The external drive must not become the only copy of the project. GitHub protects committed source, but it does not protect uncommitted files, ignored secrets, local configuration, datasets, or generated research.

## Existing External Backtest Storage

Large research artifacts currently use these external locations:

```text
/Volumes/1TB/BremLogicStorage/backtest/data
/Volumes/1TB/BremLogicStorage/backtest/results
```

The project currently accesses them through links under `research/backtest`. These paths should be folded into the final APFS migration and reverified afterward.

## Final Recommendation

Do not directly move the complete BremBot repository onto the current exFAT volume. Prepare an APFS destination, copy without deleting the source, verify both byte contents and filesystem semantics, test every local and remote workflow, then remove the internal copy only after explicit approval.
