# search-channels

Automated IPTV channel collector.

## What it does

1. Reads the channel universe from `my-ip-tv/Brightis.m3u`.
2. Searches public GitHub code globally for alternative stream URLs for those exact channel names.
3. Searches the general web through the **Brave Search API**.
4. Removes duplicate URLs.
5. Checks every candidate URL online before adding it.
6. Writes verified alternatives to `my-ip-tv/সার্চ কালেকশন.m3u`.
7. Searches GitHub and the general web for live-event streams and writes verified results to `my-ip-tv/live-event-channel-colector.m3u`.

## Google change in 2026

Google changed its Programmable Search Engine product in 2026. New Search Engines now use the **Sites to search** model rather than newly-created unrestricted full-web engines. Google also states that the Custom Search JSON API is closed to new customers, with existing customers transitioning by January 1, 2027.

This project therefore does **not** depend on creating a new Google full-web engine. Existing Google CSE credentials are retained only as an optional legacy path.

The primary general-web provider is Brave Search API. Keep the Brave API key only in Render/local environment variables and never commit it.

## Search strategy

Normal collection is anchored strictly to the current channel universe in `Brightis.m3u`.

For each target channel the collector:
- searches GitHub public code;
- searches the general web;
- extracts `.m3u`, `.m3u8`, and `.ts` URLs from results and fetched result pages;
- removes duplicates;
- excludes the original Brightis URL;
- verifies candidates online before writing them;
- keeps up to `MAX_RESULTS_PER_CHANNEL` verified alternatives.

The live-event collector separately searches sports/live-event queries and verifies URLs before writing them.

## Brightis update behavior

- Every process start performs one complete collection run.
- At the start of every run, the collector fetches the **latest** `my-ip-tv/main/Brightis.m3u` and parses it as the current baseline/target channel list.
- If Brightis.m3u gains, removes, or renames channels, the next run automatically follows the new list.
- Render Cron starts the job every **3 hours**.
- The sports/live-event collector runs in the same cycle.

## Required environment

- `GITHUB_TOKEN`
- `BRAVE_API_KEY`

Optional legacy Google:
- `GOOGLE_API_KEY`
- `GOOGLE_CX`
- `GOOGLE_ENABLED=true`
