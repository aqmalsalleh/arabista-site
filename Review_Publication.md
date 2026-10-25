# Staging review publication

This publishes Ready reviews from the private Review Studio workbook into a separate spreadsheet, `Arabista_Review_Public_Feed_STAGING`, and copies their photos into a separate Drive folder. It does not generate reviews, call OpenAI, change Retail, change the Operations database, or update FYP.

The local files are the current workspace export. The Google Apps Script project was not opened or changed by this work. Compare these files with the project before pasting them in. `Arabista_Review_Studio_Master_Doc.md` is not in this folder; the studio record is section 9 of `Arabista_Live_Commerce_Master_Doc.md`.

## Files

- `ReviewPublisher.gs` is the new publisher.
- `ReviewStudio1.gs` calls it only after a successful save, delete, or reorder has released its lock.
- `ReviewStudio.html` adds **Publish staging feed** for the signed-in owner.
- `ReviewAI.gs`, `ReviewImage.gs`, `ReviewBatch.gs`, and `ReviewBridge.html` are unchanged.

There is no public writing endpoint. `doGet` and `doPost` are unchanged. The publisher does not create a trigger.

## Script Properties

Leave publication off until the feed spreadsheet and Drive folder exist.

| Property | Value |
| --- | --- |
| `REVIEW_ENVIRONMENT` | `STAGING` exactly |
| `REVIEW_PUBLICATION_ENABLED` | `FALSE` until the backfill check, then `TRUE` exactly |
| `REVIEW_PUBLIC_FEED_SPREADSHEET_ID` | The new feed spreadsheet, not the private review workbook |
| `REVIEW_PUBLIC_MEDIA_ROOT_FOLDER_ID` | A new public folder, not a private Review Studio folder and not a file |

The sample thumbnail file must not be used as the folder. An image URL is not a folder ID.

The existing password, admin email, spreadsheet, and private Drive properties stay as they are. The publisher reads `REVIEW_ADMIN_EMAIL` when both it and the active Google account are present. A trigger has no visitor email, so it uses the same staging rule as the batch worker.

## Permissions

The studio project already uses Sheets and Drive. The first publication may ask the owner to allow them again if the new file is authorized separately. The owner account must be able to read the private workbook and source images, write the feed spreadsheet, and create files in the public folder.

Share the public folder as **Anyone with the link** can view before enabling publication. `makeCopy` puts the copy in that folder and does not change sharing on the original image. A copy is visible in an incognito window only when that folder sharing applies to it.

## Public feed schema

These tabs are created in `Arabista_Review_Public_Feed_STAGING` only.

`PUBLIC_REVIEWS`

| Column | Content |
| --- | --- |
| Public review ID | The existing Review ID |
| SKU | Product SKU, such as `D06` |
| Name | Reviewer display name |
| Date | `YYYY-MM-DD` |
| Stars | Stored rating from 1 to 5 |
| Text | Review text, unchanged |
| Display order | Stored order |
| Photos | JSON array of `{ "sequence": 1, "url": "https://drive.google.com/thumbnail?id=PUBLIC_FILE_ID&sz=w1200" }` |

`PUBLICATION_META`

| Key | Value |
| --- | --- |
| `revision` | Increases by 1 after each successful feed write |
| `updatedAt` | UTC time of that write |
| `environment` | `STAGING` |
| `readyCount` | Ready reviews read |
| `publishedCount` | Rows written |

The feed does not contain a verified-purchase flag, a review count, a rating average, original Drive IDs, reference file IDs, passwords, API keys, prompts, job logs, orders, or Script Properties.

## Private mapping and log

These tabs are added to the private Review Studio workbook. They are not part of the public feed.

`REVIEW_PUBLICATION_MAP`

| Column | Content |
| --- | --- |
| Media ID | Original `REVIEW_MEDIA` ID |
| Original Drive file ID | Private source file |
| Review ID | Review ID |
| SKU | Product SKU |
| Published file ID | Public copy |
| Source updated at | Source file modification time |
| Last synced at | Last successful use of that mapping |

`REVIEW_PUBLICATION_LOG` records one row per attempt: time, `SUCCESS` or `ERROR`, ready count, published count, copies created, copies reused, records removed, error count, and a short detail.

`REVIEW_PUBLICATION_STATE` keeps the last attempt, last success, last revision, and the same counts.

## Synchronization

A review is published only when its status is exactly `Ready`. `Draft` and `Archived` are left out. Only media whose type is exactly `photo` is copied. `reference` is never copied.

The same Review ID is updated in place. A second run reuses a public copy when the source file ID and modification time are unchanged and the copy is still in the SKU folder. A changed source file creates or reuses the replacement copy, but the previous public copy stays in place until the new `PUBLIC_REVIEWS` sheet has been written. If that write fails, the previous feed and every image it still names are left untouched. The private map is not switched to the replacement until that write succeeds. A named copy left behind by an interrupted run is reused instead of copied again. The next successful sync then retires the superseded public copy, and only when it is inside the SKU folder and is no longer named by the committed feed.

If a source image cannot be read, the publisher checks the previous public copy. It keeps that URL only when the copy still exists, is not trashed, and is inside the SKU folder. The log says the source could not be read and the previous public copy was kept. If that copy is missing or trashed as well, the photo is omitted, the review text still publishes, and the log says the public copy is unavailable. Other reviews are not removed.

Archived, draft, or deleted reviews leave the feed after the feed write succeeds. Their public copies are trashed only when the private map says this publisher created them and the file is directly inside the matching SKU folder. Original images are not moved, trashed, or reshared. Files that are not in the map are left alone. If a public file cannot be proved to belong to that folder, it is left in place and the map row remains so the next run can try again.

Save, delete, and reorder publish after they release the script lock. A publication failure does not change the saved review. The manual button and `rsPublishReconcile_` take the lock themselves. The manual button waits up to 20 seconds. The automatic call waits 5 seconds and leaves the work for the next attempt if the lock is busy.

`rsPublishReconcile_` is the optional reconciliation function. In Apps Script, open **Triggers**, choose **Add trigger**, select `rsPublishReconcile_`, **Time-driven**, and **Every 15 minutes**. Do not add it from code. The batch trigger `rsBatchTick_` stays separate.

The log and state tabs show the latest ready count, published count, copies created, copies reused, records removed, errors, and last success. A failed feed write does not mark a success. Run the sync again after fixing the cause.

## Manual initialization

1. Create an empty spreadsheet named `Arabista_Review_Public_Feed_STAGING`. Copy its spreadsheet ID.
2. Create a new Drive folder for public review photos. Share it as **Anyone with the link** can view. Copy the folder ID. Do not reuse a private Review Studio folder or the sample image ID.
3. In the Review Studio Apps Script project, set `REVIEW_PUBLIC_FEED_SPREADSHEET_ID` and `REVIEW_PUBLIC_MEDIA_ROOT_FOLDER_ID`. Set `REVIEW_PUBLICATION_ENABLED` to `FALSE`. Confirm `REVIEW_ENVIRONMENT` is exactly `STAGING`.
4. Compare `ReviewPublisher.gs`, `ReviewStudio1.gs`, and `ReviewStudio.html` with the files already in the Apps Script project. Paste the local versions only where they match this export, then add `ReviewPublisher.gs` as a new script file.
5. Deploy a new version of the existing Review Studio web app. Do not create a second web app. Do not change Retail or the public catalog.
6. Open the studio, sign in, and click **Publish staging feed**. The notice should say publication is turned off. The private reviews and the new feed spreadsheet should be unchanged.
7. Set `REVIEW_PUBLICATION_ENABLED` to `TRUE`. No new deployment is required for a property change.
8. Click **Publish staging feed** again. The first run creates the feed tabs and the private map. Confirm the log's ready count and open one photo URL in an incognito window.
9. Click the button again. Copies created should be 0 and the same public file IDs should remain.
10. To turn it off, set `REVIEW_PUBLICATION_ENABLED` to `FALSE`. To catch direct sheet edits, add the 15-minute `rsPublishReconcile_` trigger by hand.

## Backfill check for the current D06 rows

The owner reported 21 Ready D06 reviews and 16 photo records across 15 of those reviews. This local test does not read that workbook.

After step 8:

- `PUBLIC_REVIEWS` should contain one row per Ready review. For the reported data, that is 21 D06 rows if every Ready row has a name, a valid date, a rating from 1 to 5, text, and a display order.
- Rows that are Draft or Archived should be absent.
- Photo JSON should contain one entry per readable `photo` record, in sequence order. For the reported data, that is 16 URLs if every photo file is still an image under 6 MB.
- Reference rows should not add URLs.
- The URLs should use `https://drive.google.com/thumbnail?id=PUBLIC_FILE_ID&sz=w1200`.
- One incognito load of a new URL should show the image. The original file's sharing should be unchanged.
- The private `REVIEW_PUBLICATION_MAP` should have 16 rows if all 16 photos copied. A second click should reuse those copies.
- The feed text should match the Malay text in `REVIEWS`.
- No password, API key, original file ID, or reference file ID should appear in the feed spreadsheet.

Do not delete the 21 reviews for this check. To test removal, change one review to Archived, publish, confirm that one row and its public copies leave, then set it back to Ready and publish again. The restored review gets a new public copy. The original Drive file remains.

## Before the public catalog can read this

The feed spreadsheet must exist, publication must have completed once, and the incognito image check must pass. The public catalog is still a separate project and does not read this sheet. Giving that project read-only access, and teaching it this schema, is a later change. FYP does not display these reviews yet.
