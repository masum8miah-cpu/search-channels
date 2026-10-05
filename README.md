# search-channels

Automated IPTV channel collector.

## What it does

1. Reads the channel universe from `my-ip-tv/Brightis.m3u`.
2. Searches public GitHub code globally for alternative stream URLs for those exact channel names.
3. Optionally searches Google through Google Programmable Search / Custom Search JSON API.
4. Removes duplicate URLs.
5. Checks every candidate URL online before adding it.
6. Writes the verified duplicate/alternative channel URLs to `my-ip-tv/সার্চ কালেকশন.m3u`.
7. Searches public GitHub and Google for live-event streams and writes verified results to `my-ip-tv/live-event-channel-colector.m3u`.

## Important

The collector does not copy thousands of arbitrary channels into the main collection. The normal search collection is anchored to the channel names already present in `Brightis.m3u`.

A GitHub token is required. The token is stored only as a Render/local environment variable and must never be committed.

Google collection requires both `GOOGLE_API_KEY` and `GOOGLE_CX`. Without them, the collector continues with GitHub public-code search.

## Render

This repository includes a Render Cron Blueprint. The cron runs every two hours with a staggered minute. Change the schedule in `render.yaml` if a different frequency is wanted.


## Update cycle

- Every process start performs one complete collection run.
- At the start of every run, the collector fetches the **latest** `my-ip-tv/main/Brightis.m3u` and parses it as the current baseline/target channel list.
- If Brightis.m3u gains, removes, or renames channels, the next run automatically follows the new list; it does not use a stale local baseline.
- Render Cron starts the job every **3 hours**.
- The sports/live-event collector runs in the same cycle and writes its results to `live-event-channel-colector.m3u`.
