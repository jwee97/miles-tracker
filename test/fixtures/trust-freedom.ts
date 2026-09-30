/**
 * The Trust Freedom Card, as commands. Used by test/trust.ts, which proves every line is
 * accepted and that together they reproduce Trust's own worked examples.
 */
export const TRUST_FREEDOM_COMMANDS = `# Trust Freedom Card — verified against trustbank.sg Key Facts Sheet and Product Terms, 30 Sep 2026.
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
`;
