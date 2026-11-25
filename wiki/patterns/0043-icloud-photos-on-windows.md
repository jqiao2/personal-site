# Reading the iCloud Photos folder on Windows

**Type:** strategy · **Applies when:** a script reads photos from `Pictures\iCloud Photos\Photos`, or a local job has to put images on the site

- Some files are cloud-only placeholders (`FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS`,
  0x400000). Opening one downloads it, so filter on name, size and mtime before
  opening, and treat a read error as "try again later".
- HEIC: `sharp` cannot decode it. `pillow-heif` does, with EXIF and GPS, at about
  1.5 s a photo including the CLIP pass.
- CLIP ViT-B/32 zero-shot on the CPU is enough to find food; 0.75 is the cutoff.
  Between 0.4 and 0.75 it is people at tables.
- The R2 keys in the local `.env` are placeholders, so a local script cannot write
  the bucket. `food-inbox` goes through a private Supabase bucket instead; that
  also keeps unreviewed photos off R2's public URL.
- To drive an owner page before its migration is applied, point `SUPABASE_URL` at
  a small local proxy that passes reads through and fakes the new table.
