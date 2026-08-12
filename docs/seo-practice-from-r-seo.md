# SEO in practice, as r/SEO actually argues it

**What this is.** A synthesis of what the r/SEO community (500k members) repeats,
agrees on, and fights about — read out of the subreddit itself rather than from
blog posts about it. Where the community is confident, this says so. Where it is
guessing, this says that too, because half the value of reading a subreddit
instead of a guide is seeing which claims come with evidence and which come with
upvotes.

**How it was gathered.** 2026-08-07, through a browser session on the operator's
own machine:

- 4 listings of r/SEO — top all-time, top year, top month, hot — 95 distinct threads.
- The 24 threads with the most comments, read in full: post body plus top comment nodes.
- Ranked by **comment count, not score**. An upvoted screenshot is a joke everybody
  agreed with; a 400-comment thread is one the community argued through, and the
  argument is the part worth reading.

**Limits, stated up front.** New Reddit lazy-loads, so each listing yielded its
first ~27 posts rather than the 100 requested — a top-of-listing view, not a
census. Comments were capped at 8 nodes per thread, so deep sub-threads are
under-represented. Nothing here is a controlled experiment; it is what experienced
practitioners say in public, which is a weaker kind of evidence than a test — and
the subreddit says so about itself: *"90% of SEO is theory and a lot may be
technically wrong."*

---

## 1. The thing the subreddit agrees on above all else

**Never let Google be your only channel.** This is not a philosophical position
there. It is the lesson of the sub's most-discussed threads of the last three
years, and every one of them is somebody's income:

- A 2M-monthly-visitor blog to near-zero traffic; 8 people laid off.
- A $250k/year outdoor-gear publisher wiped out by an update; the owner
  describing eating at a food bank, having been flown to a Google Creator Summit
  months earlier.
- A content writer with a decade of Raptive/Mediavine clients losing 80% of them
  after the Helpful Content Update.
- *"In August 2022 I made $14,000, my best month ever… today my website makes
  $1,000/month."*

The community's own verdict on these, delivered bluntly and upvoted:

> *"It's hard to believe that a business can grow large enough to employ eight
> people yet still rely entirely on a single search engine algorithm."*

> *"At the end of the day it was my own fault for putting so many eggs in G's basket."*

**Practical rule:** treat organic search as one acquisition channel with a
counterparty risk you do not control. If a single algorithm update would end the
business, that is a business model problem, not an SEO problem.

There is a dissenting sharpening of this worth keeping, from a heavily-upvoted
reply to one of the collapse posts: some of the destroyed sites *were* thin
affiliate/review plays, and the updates did what they were announced to do. Both
things are true — the update was indiscriminate **and** some of the casualties had
no defensible value proposition. Read collapse stories for the mechanism, not for
the moral.

---

## 2. What Google says vs. what Google does

The May 2024 API documentation leak is the sub's single most-cited factual event,
and it reset the community's epistemics. Confirmed by the docs, after years of
public denial:

| Google said publicly | The leaked docs showed |
|---|---|
| No "domain authority" metric | `siteAuthority` exists |
| Clicks don't affect rankings | `NavBoost` uses click data |
| No sandbox for new sites | It exists |
| Chrome data isn't used for ranking | It is |

Also validated: backlink count **and diversity** matter; author expertise
signals matter; title-tag/query matching matters; page dates are tracked for
freshness.

The takeaway the sub actually drew is a method, not a fact list:

> *"Stop listening to affiliate bloggers, John Mu and other idiots. Do your own
> tests. Measure."*

**Practical rule:** treat search-liaison statements as PR with a directional
signal, not as documentation. Your own Search Console data is the only
first-party evidence you have.

---

## 3. The mental model that the good posters keep restating

Three claims recur from the sub's most credible regulars, and they compose into a
usable model.

### Ranking is page-level, not domain-level

> *"PageRank isn't a domain system; it's a page system. Pages accumulate their own
> authority, their own relevancy, their own graph of signals. That's why canonicals
> exist. That's also why cannibalization exists… There is no 'domain ranks for X.'
> The domain only provides a baseline; the page competes."*

**Consequences you can act on:** cannibalisation is real and is your own fault —
two of your pages chasing one intent block each other. Canonicals are how you
consolidate. A strong domain gets a page *considered*, it does not get it ranked.

### Topical authority is just clicks in a topic

> *"Every keyword you enter puts you into a topical space, and every key phrase you
> get clicks for is topical authority. That's the whole definition. It doesn't
> require a mystical map. Google sees clicks in a topic → you gain credibility in
> that topic."*

This deflates the topical-map/silo industry considerably, and the sub's most
prolific technical voice reduces keyword research to one line:

> *"Keyword Research: Keyword Topical Authority = Google Search Console : keywords
> in position 9-20"*

**This is the single most actionable tactic in the whole corpus.** Positions 9-20
are queries where Google already considers you relevant but has not committed.
That is where effort converts fastest — not on net-new keywords where you have no
established footprint.

### Google ranks what makes people come back, not what is "better"

Answering the perennial *"why is AI slop outranking my well-written article"*:

> *"They allowed millions of URLs to rank on top, then measured how search users
> interacted… based on that data they rank the most suitable URLs… so what will
> rank? Good content? Whatever content that makes people come back to use Google."*

Corroborated by `NavBoost` in the leak, and by a Search Console observer in the
same thread. The corollary, stated bluntly:

> *"Needing to have images or stuffing 'SEO features' into a page is not SEO. Most
> of these are superstitions."*

**Practical rule:** "quality" is not an intrinsic property of your document. It is
whether the searcher who clicked you stopped searching. Longer, prettier, more
images, more words — none of these are the mechanism. Answering the query fast
enough that they don't go back is.

---

## 4. Backlinks — the settled parts

The sub argues endlessly about links but converges on a few things.

**Quality and relevance beat volume, and it isn't close.**

> *"1 really good link outweighs thousands of spammed links."*

> *"When it comes to low quality links make sure they fit in your neighbourhood…
> they at least need to be in the same type of category."*

**You need far fewer links than the tools imply.**

> *"You'd be surprised how few links you'd need to make a solid dent… 10 a month
> over a few months, so long as the content is spot on, is usually enough. Small
> businesses certainly do not need hundreds of links to rank for local/lower
> difficulty keywords. I've seen keywords shoot up after only one or two links."*

Note the asymmetry the same poster names: getting *onto* page 1 is cheap;
cracking the top three costs more.

**The four ways to get links, per the sub's own taxonomy:**

1. Do nothing and let people link to you — only works once you're already on page 1.
2. Buy them — "make sure you know what you're doing"; universally flagged as risk.
3. Outreach / guest posts — effective, slow.
4. Build your own — best long-run, most expensive to start.

**What a practitioner reports actually working**, ranking #1 in their niche with
1/100th of competitors' backlinks:

> *"Write content for niche and highly-relevant publications, then pitch the editing
> team… Guest appear on industry-specific podcasts. We were always after relevant
> brand appearances, mentions, and links… Good backlinks don't come from buying
> them. They come from building relationships."*

**Directories:** largely spent. Mildly useful for local; stick to the top ones and
stop. Do not buy the 500-directory packages.

**Contested:** whether buying links is viable at all. One reply notes agencies with
$100k/mo retainers spending ~50% on link buying. The sub does not resolve this;
the honest read is that it works until it doesn't, and the downside is your domain.

---

## 5. GEO / AEO / "AI SEO" — the sub's current consensus is *mostly snake oil*

This is the loudest live argument in r/SEO right now, and the skeptics have the
better of it. From a 25-year practitioner, heavily upvoted:

> *"For optimisation there are barely any new techniques beyond 'do good basic SEO'.
> The visibility industry is a borderline scam. Selling visibility scores averaged
> over invented prompt baskets, queried through API endpoints no consumer uses,
> weighted by modelled volumes nobody can verify… The only stable signal is whether
> you're in the pool at all, and an afternoon a month with Bing Webmaster Tools and
> your server logs will tell you that for free."*

> *"Half the GEO visibility tools are just horoscopes with an API key and a dashboard."*

> *"Good SEO is GEO; only industry-clueless scammers and foolish bosses keep
> insisting that you should focus on GEO."*

Why the measurement is shaky, in one comment worth internalising: change the
wording, model, endpoint, location or freshness and the answer moves — then it
gets averaged into a clean score and becomes a boardroom KPI. Scraped chat UIs are
*worse* than APIs, because a UI-scraped session is logged-out, zero-context,
single-turn, with no memory, personalisation or location signal. It is not what
any real user experiences.

**`llms.txt` is explicitly called out as a waste of time.**

**Practical position:** do not buy an AI-visibility platform on today's evidence.
Do check monthly, for free, whether you appear at all — Bing Webmaster Tools,
server logs, referral traffic from AI hosts. Treat any vendor quoting you an "AI
ranking position" as selling a number they cannot produce.

---

## 6. AI-generated content — the input is what matters

The most useful answer in the corpus, from a recognised local-SEO practitioner:

> *"We use an internal tool that takes transcripts from interviews we do with small
> businesses and turns them into content… The content it produces is definitely a
> human's knowledge but the content is written by Claude. It ranks just fine despite
> failing any AI detection tools. I would not expect the same result if I just told
> Claude to write me an article on [topic X]. When we tested that, content performed
> terribly."*

And the mechanism, in the reply:

> *"This type of original material, even if packaged/edited by AI, signals E-E-A-T.
> It probably has specific names, quotes, and opinions. 'Write an article about X'
> will not have those elements."*

**Practical rule:** the question is never "did an AI write this". It is "does this
document contain information that did not previously exist on the web". Interview
transcripts, first-party data, original testing, named opinions — those are the
input. The model is a formatting layer over them, and a formatting layer over
nothing produces nothing.

---

## 7. Tools — the sub is actively de-subscribing

> *"My biggest issue is the data is so inaccurate on these SEO platforms. The
> estimations don't even match anything close to reality… I find having bad data is
> worse than having no data. Bad data can lead to the wrong conclusions, and those
> conclusions are confident."*

> *"In the era of AI it's so easy to pull your own SEO data with an API. Instead of
> paying monthly I spend about 10 cents every report I pull."*

The stack people actually name when asked what they'd keep:

- **Google Search Console** — the only first-party truth. Everything else estimates.
- **Screaming Frog** — crawling, internal-link counts, technical audit.
- **Ahrefs** *or* Semrush, not both — and increasingly neither at full price.
- **An LLM** for the busywork (audit summarisation, internal-link suggestion, bulk edits).

One in-house SEO's summary of a $10k/mo agency's entire output:
*"I literally just need Ahrefs, Screaming Frog and Claude… All of this is like two days work."*

---

## 8. Internal linking — the cheapest win, with a caveat

The highest-scoring tactical post in the corpus (734) is a deep-research prompt
that finds internal-link opportunities: crawl internal pages excluding nav/footer/
sidebar, find contextually natural placements for a target URL, exclude pages that
already link to it, and output source URL + anchor text + the exact sentence and
its position.

**The caveat, from the thread itself, matters:** ChatGPT does not truly crawl a
site — it web-searches and then *acts as if* it crawled, i.e. hallucinates. So:
feed it a sitemap, or crawl with Screaming Frog first and hand it real URLs, and
verify every suggested source page exists before you act. Screaming Frog's inlink
counts tell you where a large site is starved of internal links, which is where to
point the effort.

---

## 9. Field notes worth carrying

- **Local/service SEO still converts, and is undervalued.** A self-taught freelancer
  ranking #1 for "[city] web design" reports turning down quote requests weekly —
  while also reporting traffic down 40% YoY. Fewer clicks, still enough business.
- **A contested but repeated claim:** for businesses whose customers transact in
  person, organic rankings matter far less than the Google Business Profile and
  paid performance. *"Take an average auto repair shop… ain't no customers coming
  through that #1 website."* Exceptions named: B2B and high-ticket.
- **Multilingual expansion is a real risk vector.** One collapse was attributed by
  its owner to adding language subdirectories, which they believe diluted the main
  language's rankings. Unverified self-diagnosis — but if you internationalise,
  do it with hreflang done properly and watch the primary market weekly.
- **Scrapers can outrank the original.** Multiple accounts of verbatim-copied
  content ranking above the source for months. There is no reliable remedy in the
  thread; it is a known failure mode to plan around, not a bug you can file.
- **Agency pricing, from someone doing the work:** 2–5 person agencies run $2–5k/mo
  for genuine ongoing work — technical audits, content strategy, real outreach,
  reporting tied to traffic rather than vanity metrics. $10k+/mo means enterprise
  account-management overhead or real scale (volume content, multiple markets).
  Red flags named: keyword lists as a deliverable, bought links from spam sites,
  and "N Reddit comments per month" — *"that's not a real deliverable at agency
  scale, that's someone padding a report."*

---

## 10. If you want to be good at this — the operating checklist

Ordered by what the corpus suggests actually moves outcomes.

1. **Open Search Console and sort by position 9–20.** That set is your topical
   authority, already earned and not yet cashed. Improve those pages before writing
   anything new.
2. **Fix cannibalisation.** One intent, one page. Consolidate or canonicalise the
   rest. This is free and most sites have it.
3. **Ask what the searcher does after clicking you.** If they go back to Google,
   nothing else you do matters. Answer above the fold.
4. **Publish only what contains something that did not exist before** — your data,
   your interviews, your tests, your named opinion. Use AI to format that, never to
   originate it.
5. **Earn 5–10 genuinely relevant links a quarter** through niche publications and
   industry podcasts. Ignore volume targets. Do not buy the directory packages.
6. **Audit internal links with a real crawler**, then let an LLM propose placements
   from real URLs — and verify them.
7. **Check monthly, for free, whether you appear in AI answers** (Bing Webmaster
   Tools, logs, referrals). Buy no GEO platform on current evidence.
8. **Run your own tests and write down the results.** The sub's most respected
   voices all say the same thing: measure, because the public guidance has been
   wrong before and was proved wrong in writing.
9. **Build a second channel before you need it.** Everything above can be undone by
   one update, and the people it happened to are the ones telling you so.

---

## Sources

All quotations are from r/SEO threads read on 2026-08-07. Principal threads:
the 2024 Google API leak discussion; "A Few Things That Finally Clicked About
Authority, Topics, and How Google Actually Ranks Pages"; "GEO techniques and
visibility monitoring is pretty much all snake oil"; "Link Building in 2023:
Strategies That Have Worked"; "How do you get backlinks?"; "Has anyone actually
seen AI-generated content rank consistently in Google?"; "Bye Semrush. After 8
years, cutting the cord."; "Over $10,000 a Month for SEO??"; "The more I do SEO
the more I realize Google doesn't know what 'Quality content' even means";
"I made an awesome ChatGPT prompt for internal linking"; and the collapse threads
("An Open Letter to the Google Executives Who Killed My Business", "Let's laugh my
2M blog is officially dead", "Google Killing Industry").
