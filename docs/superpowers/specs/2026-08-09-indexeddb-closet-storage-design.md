# IndexedDB Closet Storage Design

## Goal

Allow Closet Studio to hold at least 100 photographed clothing items in Safari or Chrome while remaining a single-file, no-account GitHub Pages app.

## Constraints

- Keep the application in `index.html` with no build step or backend.
- Do not require accounts or collect identity information.
- Keep closets local to each browser and device.
- Preserve existing closet data during the upgrade.
- Keep saved-outfit behavior compatible with existing data.
- Show actionable errors instead of leaving phantom or duplicate items.

## Architecture

Create an IndexedDB database named `closetStudio` with version `1` and an `items` object store keyed by each item's numeric `id`. Each record contains the current item metadata and, when present, a compressed JPEG `Blob` in a `photo` field.

The application keeps its existing in-memory `items` array after startup. IndexedDB is the durable source for closet items. `savedOutfits` remains in `localStorage` because it contains only small arrays of item IDs. Starter items are inserted into IndexedDB only when no stored or migratable closet exists.

The storage operations sit behind small functions with one responsibility:

- Open and upgrade the database.
- Read all items.
- Put one item.
- Delete one item.
- Migrate legacy items.

UI code calls these functions and updates in-memory state only after the durable operation succeeds.

## Startup and Migration

On page load:

1. Open IndexedDB and create the `items` store if needed.
2. Check `localStorage.closetItems` for the legacy closet.
3. If legacy data exists and IndexedDB has no items, migrate every legacy record in one read-write transaction.
4. Convert any legacy base64 image into a JPEG `Blob`, store it as `photo`, and omit the old `image` string.
5. Remove `localStorage.closetItems` only after the complete migration transaction succeeds.
6. Load IndexedDB records into memory and render the closet.
7. If neither legacy nor IndexedDB data exists, insert and render the starter items.

If migration fails, retain the untouched legacy data and show an error. A later reload can retry safely. The application must not seed starter items over an existing closet.

## Adding an Item

The existing submission lock remains in place. For an uploaded photo:

1. Read and decode the selected image.
2. Resize it to a maximum dimension of 800 pixels.
3. Encode it as a JPEG `Blob` at 70% quality with `canvas.toBlob`.
4. Put the complete item record into IndexedDB.
5. Add the item to the in-memory list, clear the form, and rerender only after the database write succeeds.

If image decoding, encoding, or storage fails, unlock the form, keep the closet unchanged, and show a clear retry message.

## Displaying Photos

When rendering an item with a photo `Blob`, create a temporary object URL with `URL.createObjectURL`. Track active URLs and revoke them before replacing closet markup or when the page unloads. Items without photos continue to use their emoji.

The outfit builder and saved outfits resolve photos from the same in-memory records, so they use the same object-URL helper rather than duplicating conversion logic.

## Removing an Item

Delete the record from IndexedDB first. Remove it from the in-memory list and rerender only when the transaction succeeds. If deletion fails, preserve the visible item and show an error. Saved outfits may retain the deleted ID; the existing rendering behavior safely ignores missing items.

Because each record owns its photo blob, deleting the record also deletes the photo and cannot leave an orphaned image.

## Browser and Failure Behavior

IndexedDB is supported by current Safari, Chrome, Edge, and Firefox. Each browser and device has a separate closet. Private browsing and cleared website data can still remove the closet.

If IndexedDB cannot be opened, the app shows a storage-unavailable message and avoids destructive migration. Existing legacy data stays untouched. Export and import are intentionally deferred as a separate durability feature.

## Capacity Target

The acceptance target is 100 photographed items using 800-pixel, 70%-quality JPEG blobs on a recent iPad Safari browser. Actual capacity varies by image complexity and Safari storage policy, but IndexedDB should provide substantially more space than the former `localStorage` implementation.

## Testing

Add regression coverage for:

- Opening and upgrading the IndexedDB database.
- Seeding starter items only for a truly empty closet.
- Migrating legacy metadata and base64 images successfully.
- Retaining legacy data after a failed migration.
- Writing one compressed photo blob before updating in-memory state.
- Ignoring repeated Add clicks while encoding or writing.
- Removing the IndexedDB record before removing the visible item.
- Preserving the visible item when deletion fails.
- Revoking object URLs when rendered photos are replaced.
- Keeping saved-outfit IDs in `localStorage`.

The existing upload, compression, duplicate-submission, and storage-failure tests remain part of the suite and will be adapted to the asynchronous storage boundary.

## Out of Scope

- Accounts or authentication.
- Cloud synchronization or cross-device closets.
- Sharing closets between users.
- A backend service or build system.
- Full offline installation.
- Export and import backup.
