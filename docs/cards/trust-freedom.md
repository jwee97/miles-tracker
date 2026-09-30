# Trust Freedom Card

Read from Trust's own pages on 30 September 2026:

- [Key Facts Sheet](https://trustbank.sg/legal/trust-freedom-credit-card-key-facts-sheet/) — the rates are
  images on that page, and were read off them; the bonus-category merchant codes are its text.
- [Product Terms](https://trustbank.sg/legal/trust-freedom-credit-card-product-terms/) — the excluded codes.

`test/trust.ts` pastes these exact commands into the bot and checks the engine reproduces Trust's own
worked examples: S$15 of Stockback on S$500, and **S$274.50** for the Bonus Cashback quarter. If the
bank changes the card, change `test/fixtures/trust-freedom.ts` first and let that test say what moved.

## The card, in brief

| | Unlimited Cashback | Bonus Cashback | Stockback | Miles |
|---|---|---|---|---|
| Local | 1.5% | 1% base + 5% or 15% on the picked category | 3% until 31 Dec 2026, then 2% | 1.3 per S$1 |
| Foreign | 0.5% | 0.5% base + 5% or 15% on the picked category | 3% until 31 Dec 2026, then 0.5% | 1.3 per S$1 |
| Smallest purchase that earns | S$1 | S$1 | S$1 | S$5, in S$5 steps |
| Minimum monthly spend | none | S$500 (5%) or S$2,000 (15%) in **every** month of the quarter | none | none |
| Quarterly cap | none | S$30 of bonus (5%) / S$250 of bonus (15%) | S$500 of stock | none |

- **Unlimited Cashback applies until a mode is chosen.**
- The quarter is **three calendar months from the month the card was approved** — not a calendar quarter.
- The mode is decided by the date the purchase was **authorised**, not posted.
- Caps are on the **reward**, so the commands divide by the rate to get the spend cap.
- Bonus categories are defined by **merchant code**: 5499 convenience stores count as Dining, 5541 petrol as Transport.

## Setup

The quickest way, and the one that also cleans up a card set up before: `/cardfix freedom` shows what
would change, and `/cardfix freedom confirm stockback` applies it and records the mode you are on from
the day the card was opened. It switches off every rule the card has collected and writes the ones below.

By hand instead: paste in blocks of up to eight lines, then `/mode freedom stockback <YYYY-MM-DD>`.
Both come from `src/cards/profiles.ts`, so they describe the same card.

```
# Trust Freedom Card — verified against trustbank.sg Key Facts Sheet and Product Terms, 30 Sep 2026.
# Caps below are SPEND caps: Trust caps the REWARD, so each is the reward cap divided by the rate.
#   Stockback S$500 of stock at 3% = S$16,666.67 of spend. Bonus S$250 at 15% = S$1,666.67; S$30 at 5% = S$600.

# The four modes. Unlimited Cashback is what applies until you choose.
/mode freedom add unlimited_cashback|Unlimited Cashback|cash||default
/mode freedom add bonus_cashback|Bonus Cashback|cash|dining,shopping,travel,wellness,transport,entertainment
/mode freedom add stockback|Stockback|stock
/mode freedom add miles|Miles|miles

# Unlimited Cashback: 1.5% local, 0.5% foreign, no cap, nothing under S$1.
/addearn freedom * 1.5% mode unlimited_cashback region local min 1
/addearn freedom * 0.5% mode unlimited_cashback region foreign min 1

# Stockback: 3% local and foreign until 31 Dec 2026, S$500 of stock a quarter.
/addearn freedom * 3% mode stockback cap 16666.67 window membership_quarter min 1

# Miles: 1.3 Trust Miles per S$1, local or foreign, in steps of S$5, no cap.
/addearn freedom * 1.3 mode miles step 5

# Bonus Cashback base: 1% local, 0.5% foreign, on everything including the picked category.
/addearn freedom * 1% mode bonus_cashback region local min 1
/addearn freedom * 0.5% mode bonus_cashback region foreign min 1

# The bonus on the picked category, stacked on the base. 15% if every month of the quarter
# reaches S$2,000, 5% if every month reaches S$500. Categories are by merchant code.
# dining
/addearn freedom dining 16% mode bonus_cashback:dining tier 2000 region local cap 1666.67 window membership_quarter group bonus15 min 1 mcc 5462,5499,5811,5812,5814
/addearn freedom dining 15.5% mode bonus_cashback:dining tier 2000 region foreign cap 1666.67 window membership_quarter group bonus15 min 1 mcc 5462,5499,5811,5812,5814
/addearn freedom dining 6% mode bonus_cashback:dining tier 500 region local cap 600 window membership_quarter group bonus5 min 1 mcc 5462,5499,5811,5812,5814
/addearn freedom dining 5.5% mode bonus_cashback:dining tier 500 region foreign cap 600 window membership_quarter group bonus5 min 1 mcc 5462,5499,5811,5812,5814
# shopping
/addearn freedom shopping 16% mode bonus_cashback:shopping tier 2000 region local cap 1666.67 window membership_quarter group bonus15 min 1 mcc 4812,5137,5262,5309,5310,5311,5331,5399,5611,5621,5631,5641,5651,5655,5661,5681,5691,5712,5732,5699,5940,5941,5942,5944,5946,5947,5948,5977
/addearn freedom shopping 15.5% mode bonus_cashback:shopping tier 2000 region foreign cap 1666.67 window membership_quarter group bonus15 min 1 mcc 4812,5137,5262,5309,5310,5311,5331,5399,5611,5621,5631,5641,5651,5655,5661,5681,5691,5712,5732,5699,5940,5941,5942,5944,5946,5947,5948,5977
/addearn freedom shopping 6% mode bonus_cashback:shopping tier 500 region local cap 600 window membership_quarter group bonus5 min 1 mcc 4812,5137,5262,5309,5310,5311,5331,5399,5611,5621,5631,5641,5651,5655,5661,5681,5691,5712,5732,5699,5940,5941,5942,5944,5946,5947,5948,5977
/addearn freedom shopping 5.5% mode bonus_cashback:shopping tier 500 region foreign cap 600 window membership_quarter group bonus5 min 1 mcc 4812,5137,5262,5309,5310,5311,5331,5399,5611,5621,5631,5641,5651,5655,5661,5681,5691,5712,5732,5699,5940,5941,5942,5944,5946,5947,5948,5977
# travel
/addearn freedom travel 16% mode bonus_cashback:travel tier 2000 region local cap 1666.67 window membership_quarter group bonus15 min 1 mcc 3000-3308,3501-3839,4411,4511,4582,4722,4723,5962,7011,7012,7033
/addearn freedom travel 15.5% mode bonus_cashback:travel tier 2000 region foreign cap 1666.67 window membership_quarter group bonus15 min 1 mcc 3000-3308,3501-3839,4411,4511,4582,4722,4723,5962,7011,7012,7033
/addearn freedom travel 6% mode bonus_cashback:travel tier 500 region local cap 600 window membership_quarter group bonus5 min 1 mcc 3000-3308,3501-3839,4411,4511,4582,4722,4723,5962,7011,7012,7033
/addearn freedom travel 5.5% mode bonus_cashback:travel tier 500 region foreign cap 600 window membership_quarter group bonus5 min 1 mcc 3000-3308,3501-3839,4411,4511,4582,4722,4723,5962,7011,7012,7033
# wellness
/addearn freedom wellness 16% mode bonus_cashback:wellness tier 2000 region local cap 1666.67 window membership_quarter group bonus15 min 1 mcc 5912,5997,7230,7297,7298,7997,8031,8041,8049
/addearn freedom wellness 15.5% mode bonus_cashback:wellness tier 2000 region foreign cap 1666.67 window membership_quarter group bonus15 min 1 mcc 5912,5997,7230,7297,7298,7997,8031,8041,8049
/addearn freedom wellness 6% mode bonus_cashback:wellness tier 500 region local cap 600 window membership_quarter group bonus5 min 1 mcc 5912,5997,7230,7297,7298,7997,8031,8041,8049
/addearn freedom wellness 5.5% mode bonus_cashback:wellness tier 500 region foreign cap 600 window membership_quarter group bonus5 min 1 mcc 5912,5997,7230,7297,7298,7997,8031,8041,8049
# transport
/addearn freedom transport 16% mode bonus_cashback:transport tier 2000 region local cap 1666.67 window membership_quarter group bonus15 min 1 mcc 3351-3441,4111,4112,4121,4131,4457,4784,4789,5521,5541,5542,5552,5983,7512,7513,7519,7523
/addearn freedom transport 15.5% mode bonus_cashback:transport tier 2000 region foreign cap 1666.67 window membership_quarter group bonus15 min 1 mcc 3351-3441,4111,4112,4121,4131,4457,4784,4789,5521,5541,5542,5552,5983,7512,7513,7519,7523
/addearn freedom transport 6% mode bonus_cashback:transport tier 500 region local cap 600 window membership_quarter group bonus5 min 1 mcc 3351-3441,4111,4112,4121,4131,4457,4784,4789,5521,5541,5542,5552,5983,7512,7513,7519,7523
/addearn freedom transport 5.5% mode bonus_cashback:transport tier 500 region foreign cap 600 window membership_quarter group bonus5 min 1 mcc 3351-3441,4111,4112,4121,4131,4457,4784,4789,5521,5541,5542,5552,5983,7512,7513,7519,7523
# entertainment
/addearn freedom entertainment 16% mode bonus_cashback:entertainment tier 2000 region local cap 1666.67 window membership_quarter group bonus15 min 1 mcc 4899,5733,5735,5813,5815,5816,5945,7832,7841,7922
/addearn freedom entertainment 15.5% mode bonus_cashback:entertainment tier 2000 region foreign cap 1666.67 window membership_quarter group bonus15 min 1 mcc 4899,5733,5735,5813,5815,5816,5945,7832,7841,7922
/addearn freedom entertainment 6% mode bonus_cashback:entertainment tier 500 region local cap 600 window membership_quarter group bonus5 min 1 mcc 4899,5733,5735,5813,5815,5816,5945,7832,7841,7922
/addearn freedom entertainment 5.5% mode bonus_cashback:entertainment tier 500 region foreign cap 600 window membership_quarter group bonus5 min 1 mcc 4899,5733,5735,5813,5815,5816,5945,7832,7841,7922

# The minimum that decides the Bonus Cashback tier. Only applies while on Bonus Cashback.
/req freedom|monthly_min|500|membership_quarter||||Bonus Cashback minimum|bonus_cashback
/tiers freedom 500=0 2000=0

# Exclusions, from the Product Terms.
/exclude 4900,6513,7349 freedom utilities, rentals and cleaning services
/exclude 4829,5960,6010,6011,6012,6051,6211,6300,6540 freedom financial institutions, quasi cash, insurance, stored value, wire transfer
/exclude 7995 freedom gambling
/exclude 8211,8220,8241,8244,8249,8299 freedom educational institutions
/exclude 8398,8651,8661,9211,9222,9223,9311,9399,9402,9405 freedom charitable, political, religious organisations, government payments
/exclude 7299,7399,8999 freedom other services
```

## Not modelled

- **From 1 January 2027 Stockback pays 2% local and 0.5% foreign.** That is a new version of the card's
  rules, which goes in under Catalogue → Edit its rules with that start date — not by editing the line
  above, which would restate what 2026 earned. Its S$500 cap is on the reward, and with two rates it
  can no longer be turned into one exact spend cap; the single figure will be an approximation.
- **The first calendar month after approval waives the Bonus Cashback minimum.**
- **Exclusions without a merchant code** — cash advances, AXS, SAM and ATM, instalments, fees, top-ups.
- **Whether a purchase was foreign.** Tag it `#fx` when logging it; a statement import does not know,
  and anything untagged is priced as local.
