# Capability Map — Demo

## How to Use This File

Index of capabilities.

## Capabilities

### Capability: epg

| Field | Value |
|-------|-------|
| Name | EPG |
| Surfaces | all |
| Source roots | `src/features/epg/` |
| Entry points | `src/features/epg/EpgScreen.tsx::EpgScreen` |
| Screens and components | `EpgScreen`, `ChannelTile` |
| Services and modules | None |
| Navigation routes | `src/features/epg/EpgScreen.tsx::navigate("Player")` |
| Data dependencies | None |
| State ownership | `src/store/guideStore.ts::useGuideStore` |
| Tests | `src/features/epg/__tests__/` |
| Evidence | `src/features/epg/EpgScreen.tsx::EpgScreen` |

### Capability: channels

| Field | Value |
|-------|-------|
| Name | Channels |
| Surfaces | all |
| Source roots | `src/features/channels/` |
| Entry points | None |
| Screens and components | `ChannelsScreen`, `ChannelTile` |
| Services and modules | `src/services/CatalogService.ts::CatalogService` |
| Navigation routes | None |
| Data dependencies | `Catalog API` |
| State ownership | None |
| Tests | None |
| Evidence | `src/features/channels/ChannelsScreen.tsx::ChannelsScreen` |

### Capability: player

| Field | Value |
|-------|-------|
| Name | Player |
| Surfaces | all |
| Source roots | `src/features/player/`, `src/tv/player/` (tizen) |
| Entry points | None |
| Screens and components | `PlayerScreen` |
| Services and modules | `src/services/PlaybackService.ts::PlaybackService` |
| Navigation routes | None |
| Data dependencies | None |
| State ownership | None |
| Tests | None |
| Evidence | `src/features/player/PlayerScreen.tsx::PlayerScreen` |

### Capability: search

| Field | Value |
|-------|-------|
| Name | Search |
| Surfaces | `web` |
| Source roots | `src/features/search/` |
| Entry points | None |
| Screens and components | None |
| Services and modules | `src/services/CatalogService.ts::CatalogService` |
| Navigation routes | None |
| Data dependencies | `Catalog API` |
| State ownership | None |
| Tests | None |
| Evidence | `src/features/search/SearchScreen.tsx::SearchScreen` |

### Capability: search-history

| Field | Value |
|-------|-------|
| Name | Search History |
| Surfaces | `web` |
| Source roots | `src/features/search-history/` |
| Entry points | None |
| Screens and components | None |
| Services and modules | None |
| Navigation routes | None |
| Data dependencies | None |
| State ownership | None |
| Tests | None |
| Evidence | `src/features/search-history/SearchHistoryScreen.tsx::SearchHistoryScreen` |

## Relationships

| From | Relationship | To | Evidence kind | Evidence |
|------|--------------|----|---------------|----------|
| `epg` | shares_component_with | `channels` | shared-component | `src/features/epg/EpgScreen.tsx::ChannelTile`, `src/features/channels/ChannelsScreen.tsx::ChannelTile` |
| `epg` | navigates_to | `player` | navigation-route | `src/features/epg/EpgScreen.tsx::navigate("Player")` |
| `channels` | shares_state_with | `epg` | shared-state | `src/features/epg/EpgScreen.tsx::useGuideStore`, `src/features/channels/ChannelsScreen.tsx::useGuideStore` |
| `channels` | related_to | `search` | shared-service | `src/features/channels/ChannelsScreen.tsx::CatalogService`, `src/features/search/SearchScreen.tsx::CatalogService` |

## Unknowns

None.
