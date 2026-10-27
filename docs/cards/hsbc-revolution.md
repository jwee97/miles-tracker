# HSBC Revolution Card

Read from HSBC's own documents on 27 October 2026:

- [10X Reward Points Terms and Conditions](https://www.hsbc.com.sg/content/dam/hsbc/sg/documents/credit-cards/revolution/offers/10x-reward-points-terms-and-conditions.pdf)
  — the earn rates, the cap, the eligible and excluded merchant codes, and the worked example.
- [Product page](https://www.hsbc.com.sg/credit-cards/products/revolution/) — confirms the same terms are the
  current ones (travel and contactless back at 10X from 1 April 2026), the 20X tier, and that there is no
  ongoing minimum spend.

`test/hsbc.ts` pastes these exact commands into the bot and checks the engine reproduces HSBC's own worked
example: **1,700 base points and 9,000 bonus points** where the purchases would otherwise have earned 13,500
bonus points — 4,280 miles at 0.4 a point.

## The card, in brief

| | |
|---|---|
| Eligible spend | an eligible merchant code **and** paid online or by tapping (Visa payWave, Apple Pay, Google Pay) |
| Rate on eligible spend | 10X = 10 HSBC points per S$1 = **4 mpd** |
| Cap | 9,000 bonus points a calendar month = **S$1,000 of spend** (9 bonus points per S$1), shared by every category |
| Everything else not excluded | 1 point per S$1 = **0.4 mpd**, no cap |
| Excluded merchant codes | 48 of them: nothing at all, not even the base |
| Local and foreign | the same |
| Minimum spend | **none** — so no `/req` |

The eligible codes: travel `3000-3999, 4411, 4511`; department and retail stores `4816, 5045, 5262, 5309-5311,
5331, 5399, 5611, 5621, 5631, 5641, 5651, 5655, 5661, 5691, 5699, 5732-5735, 5912, 5942, 5944-5949, 5964-5970,
5992, 5999`; dining `5441, 5462, 5811, 5812, 5813`; taxis and membership clubs `4121, 7997`.

Priced in **miles**, because that is the unit the whole app compares in: 25,000 HSBC points become 10,000 Asia
Miles, so 10 points is 4 miles. A rate typed as 10 would be valued as 10 miles a dollar.

## Setup

The quickest way: `/cardfix hsbcrev` shows what would change, `/cardfix hsbcrev confirm` applies it. It
switches off any rules the card has collected, writes the ones below, and leaves the programme the card pays
into alone. Use the card's nickname in place of `hsbcrev`.

By hand instead: paste in blocks of up to eight lines. Both come from `src/cards/profiles.ts`, so they
describe the same card.

```
/addearn hsbcrev * 0.4
/addearn hsbcrev travel 4 channel online cap 1000 window calendar_month group tenx mcc 3000-3999,4411,4511
/addearn hsbcrev travel 4 channel contactless cap 1000 window calendar_month group tenx mcc 3000-3999,4411,4511
/addearn hsbcrev shopping 4 channel online cap 1000 window calendar_month group tenx mcc 4816,5045,5262,5309,5310,5311,5331,5399,5611,5621,5631,5641,5651,5655,5661,5691,5699,5732-5735,5912,5942,5944-5949,5964-5970,5992,5999
/addearn hsbcrev shopping 4 channel contactless cap 1000 window calendar_month group tenx mcc 4816,5045,5262,5309,5310,5311,5331,5399,5611,5621,5631,5641,5651,5655,5661,5691,5699,5732-5735,5912,5942,5944-5949,5964-5970,5992,5999
/addearn hsbcrev dining 4 channel online cap 1000 window calendar_month group tenx mcc 5441,5462,5811,5812,5813
/addearn hsbcrev dining 4 channel contactless cap 1000 window calendar_month group tenx mcc 5441,5462,5811,5812,5813
/addearn hsbcrev transport 4 channel online cap 1000 window calendar_month group tenx mcc 4121,7997
/addearn hsbcrev transport 4 channel contactless cap 1000 window calendar_month group tenx mcc 4121,7997
/exclude 4829,6050,6051,6529,6530,6532,6533,6534,6536,6537,6538,6540,6555 hsbcrev money transfer, quasi cash, stored value
/exclude 6010,6011,6012,6211 hsbcrev financial institutions, cash disbursements, securities
/exclude 5960,6300 hsbcrev insurance
/exclude 4900 hsbcrev utilities
/exclude 6513,7349 hsbcrev rentals and cleaning services
/exclude 5199,7299,7399,8999 hsbcrev nondurable goods, other and professional services
/exclude 7511,7523 hsbcrev truck stop quasi cash, parking
/exclude 7801,7995,9754 hsbcrev gambling
/exclude 8062 hsbcrev hospitals
/exclude 8211,8220,8241,8244,8249,8299 hsbcrev educational institutions
/exclude 8398,8651,8661 hsbcrev charitable, political, religious organisations
/exclude 9211,9222,9223,9311,9399,9402,9405 hsbcrev government payments, fines, tax
```

The `channel` on each bonus line is what makes it online-or-tap only. There is one line per way of paying
because a rule has a single channel; the shared `group tenx` makes them one S$1,000 cap.

## Not modelled

- Points are worked out on the month's eligible total rounded **down to S$1**, not purchase by purchase, so a
  month can differ by a few points.
- The **20X tier** (8 mpd, a S$1,200 monthly spend cap) needs S$50,000 average daily balance in a sole HSBC
  Everyday Global Account. Not modelled.
- A purchase logged with **no payment method** is priced as if it qualified. Log online or contactless where
  you know it; an in-store dip is `offline` and earns the base.
- HSBC's terms still carry a line saying contactless earns 1 point from 15 July 2024. Its product page and the
  April 2026 announcements say tapping is back at 10X. Check the first tap on a statement.
- Two blogs list MCC `7011` (hotels) as eligible; HSBC's list does not, and neither does it list `4722`
  (travel agencies). This follows HSBC's list.
- Exclusions that have no merchant code: instalment plans, AXS, ATM, fees, top-ups.
- Bonus points are credited after the month ends, and a reversed purchase takes its points back.
- If HSBC changes the card, change the profile in `src/cards/profiles.ts` first and let `test/hsbc.ts` say
  what moved.
