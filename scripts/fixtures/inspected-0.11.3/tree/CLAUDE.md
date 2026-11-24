# CLAUDE.md — Demo

## Project Overview

Demo.

## Tech Stack

- Language(s): TypeScript
- Framework(s): React
- Platform(s): React web, Tizen
- Runtime / Tooling: Node
- Package manager(s): npm

## Targets and Surfaces

| Surface | Platform | Form factor | Build selector | Source roots | Shared with | Packaging | Minimum OS / runtime | Evidence |
|---------|----------|-------------|----------------|--------------|-------------|-----------|----------------------|----------|
| `web` | React web | desktop | `vite build` | `src/` | `tizen` | static bundle | Not declared | `vite.config.ts` |
| `tizen` | Samsung Tizen (React) | tv | `tizen package` | `src/tv/`, `tizen/` | `web` | .wgt widget | Tizen 6.0 | `tizen/config.xml::required_version="6.0"` |

### Shared Code

| Source root | Shared by | Mechanism | Evidence |
|-------------|-----------|-----------|----------|
| `src/components/` | `web`, `tizen` | single bundle import | `src/features/epg/EpgScreen.tsx::ChannelTile` |

## Repository Structure

```text
src/
```

## Key Modules

| Module / Folder | Responsibility |
|-----------------|----------------|
| src | app |

## Entry Points

src/index.ts

<!-- audit-sync:important-files:start -->
_No approved audits yet._
<!-- audit-sync:important-files:end -->
