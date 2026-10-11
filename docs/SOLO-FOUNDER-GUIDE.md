# Solo Founder Field Guide

A guide for non-technical founders running a one-person company: what to know before you start, what AI agents still leave to you, and just enough of the technical side to judge their work.

## Part one: Ten things to know

1. **Your job is deciding, not doing.** Agents write code, copy and research. Only you pick the customer, the problem and what "good" looks like. Write those down; vague asks get confident, wrong work.
2. **Sell before you build.** Talk to 10–20 potential customers first. Get a pre-order, a waitlist with real intent, or a paid pilot. Most solo companies die from building something nobody pays for.
3. **Check results, not claims.** AI reports success confidently. Click through the product yourself, as a customer would, before every release. Keep a short "it works when…" checklist.
4. **Keep the stack boring and owned.** Mainstream tools (Stripe, a standard host, one database, GitHub), accounts in your own name. No contractor or tool should hold the only key to your domain, code or customer data.
5. **Know the money basics.** An LLC, a separate bank account, Stripe for payments, simple books, 25–30% set aside for taxes. Put a spending cap on every usage-billed service.
6. **Security and privacy are on you.** 2FA everywhere, a password manager, no secrets pasted into chats or code, backups, and a plain privacy policy if you hold customer data.
7. **Distribution is half the job.** Pick one or two channels where your customers already are, and show up every week. Building in public works well for solo founders.
8. **Automate the repeat work; keep the judgment.** Reports, support triage, posting and monitoring can run on schedules. Pricing, refunds, anything legal and anything public in your name stays with you.
9. **Protect your time and energy.** Ship small every week, one main goal per quarter, no to everything else. Burnout kills more solo companies than competitors.
10. **Know when to pay a human.** A lawyer for contracts and terms, an accountant at tax time, and a senior engineer for a one-off review before you handle payments or sensitive data.

## Part two: What AI still leaves to you

AI agents, and an agent team like Agent 007, can now do most of the building and a lot of the running: code, tests, deploys, research, drafts, reports, even reviewing and merging their own work. What's left is judgment, relationships and accountability. None of it needs a course. Each gap below takes an afternoon to a weekend to get good enough, then improves with practice.

### Knowing what to build

- **Why it's still yours:** Agents build exactly what you ask, very well. They can't sit with your customer and feel what hurts enough to pay for.
- **Learn it fast:** Read one short book (about two hours), then do five customer calls this week asking about what they did last time, not what they'd like.
- **Start with:** *The Mom Test*, Rob Fitzpatrick

### Taste

- **Why it's still yours:** AI produces competent, average work by default. Someone has to recognize the difference between fine and great, and say no to fine.
- **Learn it fast:** One afternoon: collect ten products you admire in your space and write one line on why each works. Judge every release against that file.
- **Start with:** Your own swipe file of ten products; [Laws of UX](https://lawsofux.com/) (free, an hour)

### Briefing the work

- **Why it's still yours:** The output is only as good as the ask. A vague request gets a confident, wrong result; a clear one gets it right the first time.
- **Learn it fast:** An hour of practice with a four-line template: who it's for, the problem, "done when…", and what's out of scope. Rewrite your next three requests in it.
- **Start with:** [Shape Up](https://basecamp.com/shapeup) (free: the chapter on writing the pitch)

### Judging the result

- **Why it's still yours:** Agents report success confidently and test what they thought of. You're the one who knows what the customer will actually try.
- **Learn it fast:** Write a one-page "it works when…" checklist and click through every release as a customer would. Learn to skim a pull request's summary and screenshots; you don't need to read the code.
- **Start with:** [GitHub Skills](https://skills.github.com/) (free: Review pull requests, under an hour)

### Distribution and trust

- **Why it's still yours:** Agents can draft and even post. Reputation, relationships and a real voice are yours, and people buy from people they trust.
- **Learn it fast:** Pick one channel where your customers already are, read its rules, and show up weekly with something useful. Ask your agent to draft; you edit and sign.
- **Start with:** *Traction*, Gabriel Weinberg and Justin Mares: the "Bullseye" chapter

### Money decisions

- **Why it's still yours:** Agents can propose prices and spend money on services. Only you decide what something is worth and what you can afford.
- **Learn it fast:** One spreadsheet in an afternoon: price, cost per customer (AI usage, hosting, data), margin. Put a spending cap on every usage-billed service. Ask five customers what they'd pay before you set a price.
- **Start with:** *Profit First*, Mike Michalowicz (the first chapters)

### Accountability

- **Why it's still yours:** Security, privacy and legal duties land on the company, which is you. An agent can follow rules; it can't be responsible.
- **Learn it fast:** An hour on a security checklist: 2FA, a password manager, no secrets in chats, tested backups. Skim the common web risks once. Pay a lawyer for one hour on your terms and privacy policy.
- **Start with:** [OWASP Top 10](https://owasp.org/www-project-top-ten/) (free, 30 minutes); [Stripe guides](https://stripe.com/guides) (free)

### A map of your own system

- **Why it's still yours:** When something breaks, or a contractor leaves, you need to know where the code, the data, the domain and the money live, and who holds each key.
- **Learn it fast:** Ask your agent for a one-page map in plain words, then check each account is in your name. Update it when something big changes.
- **Start with:** [Cloudflare Learning Center](https://www.cloudflare.com/learning/) (free: "what is DNS" and "what is a domain")

### Focus

- **Why it's still yours:** When building is cheap, it's easy to build too much. Your scarce resources are your attention and your customers' attention.
- **Learn it fast:** One goal per quarter. A 30-minute weekly review of what your agents are working on: drop anything that doesn't move the goal.
- **Start with:** *Company of One*, Paul Jarvis

## Part three: The technical side, just enough

You don't need to build it. You need enough to judge it: read what your agents propose, spot a bad decision before it's expensive, and ask the right question. Here is what's worth knowing, what to skip, and the defaults that fit almost every one-person company.

### Six concepts worth an hour each

From Cloudflare's Learning Center and similar, these are the pages that matter. Everything else there is for network engineers.

#### How a website reaches a visitor

Domain, DNS, server, HTTPS, CDN: the path from typing your address to seeing the page. This is most of what breaks on launch day.

- [What is DNS?](https://www.cloudflare.com/learning/dns/what-is-dns/)
- [What is SSL?](https://www.cloudflare.com/learning/ssl/what-is-ssl/) (the padlock, HTTPS)
- [What is a CDN?](https://www.cloudflare.com/learning/cdn/what-is-a-cdn/)

#### The parts of an app

Frontend (what people see), backend (the logic), API (how parts talk), database (what's remembered). Your agents' plans will use these words in every sentence.

- [MDN Learn](https://developer.mozilla.org/en-US/docs/Learn): the "how the web works" pages

#### What "the cloud" actually sells

Renting computers, storage and ready-made services by the hour or by use. Serverless means you pay per request instead of per machine.

- [What is the cloud?](https://www.cloudflare.com/learning/cloud/what-is-the-cloud/)
- [What is serverless?](https://www.cloudflare.com/learning/serverless/what-is-serverless/)

#### Environments and secrets

Test and production are separate copies; keys and passwords live in a secret store, never in code or chats. Most founder disasters start here.

- [The Twelve-Factor App](https://12factor.net/): read "Config" and "Dev/prod parity"

#### Email that lands

If your app sends email, three DNS records decide whether it reaches inboxes or spam. Set them once.

- [What are DMARC, DKIM and SPF?](https://www.cloudflare.com/learning/email-security/dmarc-dkim-spf/)

#### Attacks, by name only

Know what a DDoS, a leaked key and an injection attack are, so you recognize them in a report. Your providers and agents handle the defenses.

- [What is a DDoS attack?](https://www.cloudflare.com/learning/ddos/what-is-a-ddos-attack/)
- [OWASP Top 10](https://owasp.org/www-project-top-ten/), headings only

**Safe to skip:** BGP, anycast and routing · Zero Trust, SASE and firewall internals · Kubernetes and containers beyond the name · microservices · IPv6 · algorithms and data structures · which programming language (let your agent pick a mainstream one) · caching strategies · "how to scale to millions" until you have thousands.

### Defaults for a one-person company

Start with the default. Move off it only for the reason in the last column. Brand names are common examples, not endorsements.

| You need | Default | Examples | Choose something else when |
| --- | --- | --- | --- |
| Marketing site | A static site host | Cloudflare Pages, Vercel, Netlify; Framer or Webflow without code | Rarely; it's cheap and fast. |
| Web app | One app, one framework, on a managed platform | Next.js, Rails or Django on Render, Fly.io, Railway or Vercel | A customer or compliance demands a big cloud, or you have big-cloud credits. |
| Big cloud | Not yet | AWS, Google Cloud, Azure | Enterprise customers, compliance (SOC 2, HIPAA), or needs the platforms can't meet. |
| Database | Managed Postgres | Supabase, Neon, AWS RDS | SQLite for a local or single-user tool; a NoSQL store only for a specific, proven reason. |
| Files and images | Object storage | S3, Cloudflare R2 | Never in the database or on the server's disk. |
| Logins | Buy it | Clerk, Auth0, Supabase Auth | Never build your own. |
| Payments | Stripe or a merchant of record | Stripe; Paddle or Lemon Squeezy to offload sales tax | Never store card numbers yourself. |
| Sending email | A transactional email service | Postmark, Resend, Amazon SES | Never from your own server. |
| Scheduled jobs | The platform's scheduler or queue | Platform cron, a managed queue | When jobs run for hours, give them their own worker. |
| Search | Your database's built-in search | Postgres full-text search | Millions of documents or fuzzy, typo-tolerant search: Algolia, Meilisearch. |
| AI features | An API from a major model provider | Anthropic, OpenAI, Google | Self-host a model only for privacy rules or very high volume. |
| Errors and uptime | Error tracking plus an uptime check | Sentry, Better Stack, UptimeRobot | Day one; it's how you hear about problems before customers do. |
| Mobile app | A good mobile website first | A responsive web app or PWA | Customers need offline use, push notifications or the app stores: Expo / React Native. |

### Is this architecture good?

You can judge it without reading code. Good architecture at your size is boring, cheap and easy to explain.

#### Good signs

- You can draw it in five boxes and explain it in a paragraph.
- Managed services instead of servers someone has to maintain.
- One app, one database, one place it's deployed.
- Tests run automatically on every change; a deploy is one merge, and so is a rollback.
- Secrets in a secret store; test and production separate.
- Backups that have been restored at least once.
- Monthly cost you can predict, with caps on anything billed by use.
- Every account in the company's name, not a contractor's.

#### Red flags

- Microservices, Kubernetes or several databases before you have real traffic.
- "Only I can deploy it" or "only this one machine runs it."
- Passwords or API keys in the code, a chat or a spreadsheet.
- A custom login system or storing card numbers.
- No way to undo a release.
- A tool chosen because it's new and exciting, not because it's needed.
- Nobody can say what it costs at ten times today's users.

### Questions to ask your agent

Ask these about any plan or design. The answers tell you more than the diagram does.

1. What's the simplest version that would work, and why isn't that the plan?
2. What happens when this service goes down, and how would we know?
3. How do we undo this if it goes wrong?
4. What does this cost per month now, and at ten times the users?
5. Where do the secrets and customer data live, and who can reach them?
6. What would we have to rebuild to move off this provider?
7. Which part of this would a senior engineer push back on?

---

Books are listed by title and author; free resources are linked. Check each before you commit time or money.

Agent 007 helps with the building and running part: a manager agent turns a goal into job cards, workers open pull requests, and you review and merge. See the [README](../README.md).
