# Account Data Sharing - Design Document

> **Version**: 1.0 | **Date**: 2026-03-05 | **Status**: Implementing

## 1. Business Context

### 1.1 Use Cases

| Scenario | Description |
|----------|-------------|
| Account Migration | User leaving team, needs to transfer workspaces/configs to replacement |
| Team Onboarding | Experienced user shares templates/configs to new team member |
| Cross-Account Collaboration | Share specific workspaces between users without making public |

### 1.2 Core Concept

**Data Sharing** = Sender selects data items + Receiver user => Create a "transfer request" => Receiver accepts/rejects => System deep-copies data to receiver's account.

Key principle: This is a **deep copy** (not linking/referencing). After transfer, sender and receiver each own independent copies.

## 2. Data Model

### 2.1 AccountDataTransfer

| Field | Type | Description |
|-------|------|-------------|
| `Id` | string | Unique transfer ID |
| `SenderUserId` | string | Sender's user ID |
| `SenderUserName` | string | Snapshot of sender's display name |
| `ReceiverUserId` | string | Receiver's user ID |
| `ReceiverUserName` | string | Snapshot of receiver's display name |
| `Items` | List<DataTransferItem> | Shareable items list |
| `Status` | string | pending / processing / completed / rejected / expired / cancelled / partial / failed |
| `Message` | string? | Sender's optional message |
| `Result` | DataTransferResult? | Execution result summary |
| `ExpiresAt` | DateTime | Expiry time (default: 7 days) |

### 2.2 DataTransferItem

| Field | Type | Description |
|-------|------|-------------|
| `SourceType` | string | workspace / literary-prompt / ref-image-config |
| `SourceId` | string | Source document ID |
| `DisplayName` | string | Snapshot of item name at creation time |
| `AppKey` | string? | Application key |
| `AppKeyDisplayName` | string? | Human-readable app name (from backend) |
| `PreviewInfo` | string? | Extra preview info (e.g. "47 images") |
| `CloneStatus` | string | pending / success / failed / source_missing |
| `CloneError` | string? | Error message if failed |

### 2.3 Shareable Types

| SourceType | Collection | Deep Copy Includes |
|------------|------------|-------------------|
| `workspace` | image_master_workspaces | Workspace + all ImageAssets + all Messages + Canvas |
| `literary-prompt` | literary_prompts | Prompt content (fork-style copy) |
| `ref-image-config` | reference_image_configs | Config + image URL reference |

## 3. State Machine

```
                  +---> [rejected]
                  |
[pending] --+---> [processing] --+--> [completed]
            |                    +--> [partial]
            |                    +--> [failed]
            +---> [cancelled] (sender cancels)
            +---> [expired]   (auto after 7 days)
```

## 4. API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/account/data-transfers` | Create transfer request |
| GET | `/api/account/data-transfers?direction=sent\|received` | List transfers |
| GET | `/api/account/data-transfers/{id}` | Get transfer detail |
| POST | `/api/account/data-transfers/{id}/accept` | Accept & execute deep copy |
| POST | `/api/account/data-transfers/{id}/reject` | Reject transfer |
| POST | `/api/account/data-transfers/{id}/cancel` | Sender cancels |
| GET | `/api/account/data-transfers/my-workspaces` | List sender's workspaces |
| GET | `/api/account/data-transfers/my-configs` | List sender's configs |

## 5. UI Design

### 5.1 Page Layout (Left-Right Split)

```
+------------------------------------------------------------------+
| [icon] Data Sharing                          [Refresh] [+ Share]  |
+------------------------------------------------------------------+
|  [Received] [Sent]  |  Detail Panel / Empty State                |
|                      |                                            |
|  TransferCard 1      |  Sender avatar + name                     |
|  TransferCard 2      |  Status badge + timestamp                 |
|  TransferCard 3      |  Message (if any)                         |
|  ...                 |  Item list with clone status               |
|                      |  Result summary                            |
|                      |  Action buttons (Accept/Reject/Cancel)     |
+----------------------+--------------------------------------------+
```

### 5.2 Create Transfer Dialog (Modal, NOT inline panel)

The creation flow uses a **Dialog modal** (not a right-panel replacement). This preserves context of the transfer list while creating.

```
+---------------------------------------------+
| [icon] New Data Share                    [X] |
+---------------------------------------------+
| Step indicator: 1-Select Data  2-Confirm     |
|                                              |
| Recipient: [User Dropdown with avatar]       |
| Message:   [Optional text input]             |
|                                              |
| [Search items...]                            |
|                                              |
| > Literary Workspaces (2)           [Select] |
|   [x] Workspace A              47 images     |
|   [ ] Workspace B               1 image      |
|                                              |
| > Visual Workspaces (2)            [Select]  |
|   [ ] Workspace C               8 images     |
|   [ ] Workspace D              23 images     |
|                                              |
| > Configs (1)                       [Select] |
|   [ ] Style 1                    ref image   |
|                                              |
+---------------------------------------------+
| Selected: 3 items                   [Share]  |
+---------------------------------------------+
```

### 5.3 Design Decisions

| Decision | Rationale |
|----------|-----------|
| Modal for creation | Preserves list context; creation is a focused task |
| No stats cards | Low-frequency feature; stats add noise |
| Backend provides displayName for appKey | Follows frontend architecture principle |
| Search filter in creation | Users may have 100+ workspaces |
| Confirmation implicit in send button | Single-step is sufficient; transfer requires receiver acceptance anyway |

## 6. Notification Flow

1. Sender creates transfer => System notification to receiver (with deep link)
2. Receiver accepts => System notification to sender with result summary
3. Receiver rejects => System notification to sender

## 7. Security

- Sender can only share data they own (verified by `OwnerUserId` check)
- Receiver must explicitly accept; no auto-transfer
- Transfer expires after 7 days
- Only sender/receiver can view a transfer
- Permission: `system` module access required

## 8. MongoDB Collection

- Collection: `account_data_transfers`
- Indexes: `SenderUserId + CreatedAt desc`, `ReceiverUserId + CreatedAt desc`
