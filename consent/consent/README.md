# Consent pack

Fills patient and clinician details into RCR radiotherapy and CRUK SACT consent forms, adds Macmillan leaflets, and produces a print pack. Everything is processed in the browser; patient details are never uploaded or stored.

## Setting it up (once)

1. Copy these into the root of the `am-oncology.github.io` repository, keeping the folders:
   - `consent/` (the tool)
   - `scripts/update_consent_library.py` and `scripts/requirements-consent.txt`
   - `.github/workflows/update-consent.yml`
2. Commit and push.
3. In GitHub: **Settings → Actions → General → Workflow permissions**, choose **Read and write permissions** and save.
4. In GitHub: **Actions → Update consent → Run workflow**. The first run downloads everything and takes roughly 30–60 minutes (Macmillan is the slow part). Later runs only commit what changed.
5. Open `https://am-oncology.github.io/consent/`.

The workflow then runs every Monday morning.

## Everyday use

1. Paste the patient banner from the record. Check the label and the fields underneath.
2. Choose your saved clinician details.
3. Search for forms (e.g. "rectal", "capecitabine") or click a saved bundle. Add any suggested leaflets.
4. Press **Fill forms**, check the preview, then **Open print pack** or **Download all (ZIP)**.
5. Press **Next patient** to clear the patient and keep the same pack.

If a detail lands in the wrong place, drag the box or change "Fill with" in the table. The change is remembered for every form from the same source with that printed label.

## Local forms

Put PDFs in `consent/custom/` (sub-folders become groups) and push. The library re-indexes automatically.

## Turning off Macmillan

Edit `.github/workflows/update-consent.yml` and remove `macmillan` from the `SOURCES` line, then delete `consent/library/macmillan/`.

## If something breaks

The Actions run summary shows a table per source. If RCR, CRUK or Macmillan change their website layout, that source shows as failed and the previous week's files stay in use; the page also says so under "Forms and leaflets".

## Moving to another computer

Footer → **Export my settings** saves clinician details, bundles and field adjustments to a file; **Import settings** loads them elsewhere.
