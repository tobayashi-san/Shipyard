# Shipyard Development Pipeline

This document defines how changes move from local development to a published
Shipyard release.

## Development Flow

1. Create a feature or fix branch from the latest `main`.
2. Make the smallest coherent change and keep public API or schema changes
   explicit in the PR description.
3. Run local checks before opening the PR:
   - Backend changes: `cd server && npm run typecheck && npm test`
   - One backend test file: `cd server && node --test test/<file>.test.js`
   - Frontend changes: `cd frontend-next && npm run lint && npm run typecheck && npm test && npm run build`
   - Browser workflows: install both backend and frontend dependencies, then run
     `cd frontend-next && npm run test:e2e`.
   - Cross-cutting changes: run `npm run check` from the repository root, followed
     by the browser tests.
4. Open a pull request into `main`.
5. Merge only after the GitHub CI workflow is green.

`main` is expected to stay release-ready. Direct commits to `main` should be
reserved for urgent fixes and must still pass the same checks.

## CI Gates

The `CI` workflow runs on pull requests and pushes to `main`.

- Backend checks install `server` dependencies with `npm ci`, type-check the
  guarded OpenTofu core modules, and run `npm test`.
- Frontend checks install `frontend-next` dependencies with `npm ci`, then run the
  build, type checker, linter, and unit tests.
- Browser tests install the backend dependencies required by their local API
  server, install Firefox, and run the Playwright suite.
- Production dependencies are audited for both applications.
- Docker validation builds and loads the production image without pushing it,
  starts the container, verifies its HTTPS health endpoint, restarts it, and
  verifies that it becomes healthy again.

There is no repo-wide formatter gate. Frontend ESLint is a required gate.

## Release Flow

Shipyard uses release candidates first.

1. Merge the release content into `main`.
2. Start the `Release` workflow manually.
3. Enter a version without a leading `v`:
   - RC: `1.1.2-rc.1`
   - Stable: `1.1.2`
4. The workflow verifies that it was dispatched from `main`, validates the
   version, runs backend, frontend, browser, audit, and Docker build gates.
5. If all gates pass, the workflow updates all package versions, commits the
   version bump, creates an annotated tag, and creates a GitHub Release.
6. The workflow starts `Build and Push Docker Image` for the new tag, which
   publishes the container image to GHCR.

Stable releases use the `stable-release` GitHub Environment. Configure that
environment in GitHub with a required reviewer so stable publication pauses for
manual approval. RC releases do not require this stable approval.

## Version and Image Rules

- Version files must stay synchronized:
  - `package.json`
  - `package-lock.json`
  - `server/package.json`
  - `server/package-lock.json`
  - `frontend-next/package.json`
  - `frontend-next/package-lock.json`
- The release workflow updates those files with `tools/set-version.mjs`.
- Tags always use a leading `v`, for example `v1.1.2-rc.1`.
- Stable Docker tags publish:
  - `ghcr.io/tobayashi-san/shipyard:<version>`
  - `ghcr.io/tobayashi-san/shipyard:<major>.<minor>`
  - `ghcr.io/tobayashi-san/shipyard:latest`
- RC Docker tags publish only the explicit RC version tag and must not move
  `latest`.

## Acceptance Checks

Before treating a release as usable:

- Confirm the `Release` workflow completed successfully.
- Confirm the tag/ref-triggered `Build and Push Docker Image` workflow completed
  successfully.
- For RCs, test the explicit RC image tag with Docker Compose.
- For stable releases, confirm `latest` points to the new stable release.
