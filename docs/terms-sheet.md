# Terms sheet

One row per source host. Rule 7 in CLAUDE.md: no collector, and no hand-gathering of seed data, until a source's row says **allowed**. If a row is missing, or says **not allowed** or **pending**, stop and ask.

This repo is public, so everything here is visible. Quotes are kept short. Follow the link for the full text.

## Summary

| Source (host) | Used for | Access | ToS allows our use? | robots.txt OK? | Rate limit | Cache limit | Ids shown? | Written OK? | Status | Checked on |
|---|---|---|---|---|---|---|---|---|---|---|
| shopusa.fujifilm-x.com (Fujifilm US store) | seed data, MSRP | manual reading | **No**: crawling, indexing and cataloguing need written consent; links need permission | Product pages allowed for `*`, but Anthropic crawlers blocked and `ai-train=no` | Crawl-delay 1 s | not stated | Possibly a UPC in some product URLs (not verified) | No | **not allowed** | 2026-11-14 |
| www.fujifilm-x.com/en-us (X and GFX product info) | seed data: names, mounts, kits, colors, status | manual reading | Reading allowed; downloads "for personal, noncommercial purposes" only. **Owner's decision: facts-only use is OK** | Yes, and `Claude-User` is explicitly allowed | Crawl-delay 1–10 s by bot type | not stated | No price, part number or UPC on the X-T5 page | No | **allowed (facts only)** | 2026-11-14 |
| www.fujifilm.com/us (US corporate site, press releases) | launch MSRP, announcement dates | manual reading | No ban on automated access; text and images may not be redistributed. **Owner's decision: facts-only use is OK** | Yes for `/us/en/...` pages | not stated | not stated | Not checked yet | No | **allowed (facts only)** | 2026-11-14 |
| newsroom-us.fujifilm.com (FUJIFILM Americas News Hub) | US launch MSRP, kits, colors, announcement dates | manual reading | Same terms as fujifilm.com/us (its footer links there). **Owner's decision: facts-only use is OK** | Yes: `Allow: /` for all | Crawl-delay 10 s | not stated | Not checked yet | No | **allowed (facts only)** | 2026-11-14 |

**Facts-only limits** (owner's decision, 2026-11-14) for the sites marked "allowed (facts only)":

- Record only factual values (model name, mount, kit contents, color, status, price, date), each with its source URL.
- Copy no text and no images. No descriptions, marketing copy, spec tables or photos.
- Pages are read by hand, one at a time. No collector, scraper or bulk download.
- Never use the US store (shopusa.fujifilm-x.com), for data or for links, unless Fujifilm gives written permission.
- If Fujifilm objects, stop and remove the data (rule 8).

---

## shopusa.fujifilm-x.com: Fujifilm US online store

- **Operator:** FUJIFILM North America Corporation.
- **Terms:** <https://shopusa.fujifilm-x.com/e-commerce-terms-and-conditions/>, read 2026-11-14.
  - "Ownership and use of the Site": content may not be "crawled, indexed, catalogued, or distributed in any way, in whole or in part, without the express prior written consent of FUJIFILM."
  - "Linking to and framing the Site": "You may not create links to or from commercial sites, to or from the Site," and links without express permission are "strictly prohibited."
- **robots.txt:** <https://shopusa.fujifilm-x.com/robots.txt>, read 2026-11-14.
  - For `*`: `Content-Signal: search=yes,ai-train=no,use=reference`, `Crawl-delay: 1`. Product pages are allowed, but URLs with `?` and `/catalog/` are disallowed.
  - It specifically disallows `ClaudeBot`, `anthropic-ai` and `Claude-Web` (Anthropic's crawlers), plus `curl` and `python-requests`.
  - `ai-input` isn't set, so it neither grants nor refuses AI reading pages to answer a request.
- **Conclusion:** not allowed for seed data or a collector without written consent.
- **Rule 19 updated (2026-11-14):** hot items link to authorized retailers only, and to this store only with Fujifilm's written permission.
- **Also affects** the manufacturer-refurbished median in CLAUDE.md, which counts "the manufacturer's official refurb store". Fujifilm's refurbs can't be tracked from this store without written consent. Authorized dealers selling Fujifilm-certified refurbs still count.
- **Contact for permission:** the terms list FUJIFILM North America Corporation, Legal Department, Valhalla NY, and `digitalinfo@fujifilm.com` for store questions.

## www.fujifilm-x.com: X and GFX product information

- **Operator:** FUJIFILM Holdings Corporation. The footer "Terms of Use" link goes to the global terms.
- **Terms:** <https://global.fujifilm.com/en/terms>, read 2026-11-14.
  - Users may "display the content … and read it" and download or print "for personal, noncommercial purposes."
  - "Product names" are listed among content owned by Fujifilm or third parties.
  - "Linking to this Website is, in principle, permitted." Exceptions: framing, hot-linking images, implying affiliation, and links that harm Fujifilm.
  - No clause about crawling or automated access.
- **robots.txt:** <https://www.fujifilm-x.com/robots.txt>, read 2026-11-14.
  - All bots are allowed except on `/wp-admin/` and `/wp-login.php`.
  - "AI citation & answer engines" (including `Claude-User`) are "deliberately allowed". AI training crawlers are allowed with `Crawl-delay: 10`.
- **What's on product pages:** names, kit options and specs. No price, part number or UPC on the X-T5 US page.
- **Decision (2026-11-14):** the owner accepts facts-only use under the limits above.

## www.fujifilm.com/us: US corporate site and press releases

- **Operator:** Fujifilm Holdings America Corporation.
- **Terms:** <https://www.fujifilm.com/us/en/terms>, read 2026-11-14.
  - "You may not transmit, mirror, modify or re-distribute any images or text from this site without the express prior written permission."
  - Download and print are allowed "only for your private, non-commercial use."
  - No clause about crawling or automated access.
- **robots.txt:** <https://www.fujifilm.com/robots.txt>, read 2026-11-14. `/us/en/...` pages are allowed for `*`. Admin, search, login and asset folders are disallowed.
- **What's here:** US press releases, which normally state launch MSRP and announcement date. I haven't opened a US release yet to confirm this.
- **Decision (2026-11-14):** the owner accepts facts-only use under the limits above.

## newsroom-us.fujifilm.com: FUJIFILM Americas News Hub

- **Operator:** FUJIFILM Americas. Old fujifilm.com/us press-release links redirect here.
- **Terms:** the site's footer "Terms of Use" link goes to <https://fujifilm.com/us/en/terms>, the same terms as the fujifilm.com/us row (read 2026-11-14). The footer privacy link also goes to fujifilm.com/us.
- **robots.txt:** <https://newsroom-us.fujifilm.com/robots.txt>, read 2026-11-14. `User-agent: *`, `Crawl-delay: 10`, `Allow: /`.
- **What's here (checked 2026-11-14):** US press releases with US MSRPs, kit prices and sometimes colors, plus a release date (MM/DD/YYYY). No part numbers or UPCs.
- **Gap:** the archive starts in 2022 and has only one release for all of 2022, so older launches (X-T5, X-H2, X-T4) aren't here. Nothing was found for the X-S20, XF33 or XF56 either.
- **How to search it:** set the Year dropdown first, then the category. Setting them from a script doesn't reload the list.
- **Decision (2026-11-14):** the owner extended the facts-only decision to this host, under the same limits. Pages are read by hand, at least 10 seconds apart (its crawl delay).

---

## Sources we still need rows for

Found while gathering seed batch 1 (2026-11-14). None of these has been reviewed yet, so none may be used.

| Source | Would give us | Why we need it |
|---|---|---|
| GS1 US lookup ("Verified by GS1") | GTINs (`source_type: gs1`) | Fujifilm's allowed sites show no barcodes. |
| Authorized US retailers, at least two (for example B&H, Adorama, Best Buy) | GTINs (`source_type: retailer`, two must agree), part numbers, kit and color lists | These also need rows before any collector, so reviewing them now does double duty. |
| Physical boxes | GTINs (`source_type: box`) | Your own or a friend's gear. No terms needed, but record who read it and when. |

---

## Template for new rows

Copy this block for each new source.

```
## <host>

- **Operator:**
- **Used for:**
- **Access:** api / feed / scrape / manual reading
- **Official API or affiliate feed?:**
- **Terms:** <URL>, read YYYY-MM-DD. Section numbers and short quotes:
- **robots.txt:** <URL>, read YYYY-MM-DD. Relevant lines:
- **Rate limit:**
- **Cache or display limits:**
- **Attribution requirements:**
- **Identifiers shown (GTIN, MPN):**
- **Seller type:** manufacturer / authorized_dealer / used_dealer / marketplace
- **Condition grading page:**
- **Written permission?:** yes (where kept) / no / not needed
- **Contact for permission:**
- **Status:** allowed / not allowed / pending
```
