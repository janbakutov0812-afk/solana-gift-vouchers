# Colosseum Accelerator Application Draft — Solgift

> Working draft saved from the application-preparation session. Replace every `[TODO]` and verify factual statements before using. This repository is public, so this document is publicly visible.

## Product and market

### How do you know people need this product? (1000 characters)

People already give money for birthdays, thank-yous, and online milestones, but gifting crypto still feels like making a transfer: ask for an address, choose the right network and token, then explain how to receive it. That friction is especially high when the recipient is new to Web3.

Solgift turns that transfer into a shareable gift: choose SOL or USDC, add a personal message and card design, and send a claim link. The recipient can open the gift and connect a compatible Solana wallet. Our current evidence is the product problem and a working Devnet prototype; we are still validating demand with target users and do not claim measured adoption yet.

### How far along are you? Do you have users? (1000 characters)

Solgift is at the Devnet MVP/prototype stage. We have a deployed web demo and a codebase covering the gift-link experience, SOL/USDC flows, wallet connection, and API/escrow development. The on-chain escrow and sponsored-claim flow still need coordinated deployment and end-to-end verification before they can be presented as live features.

We do not yet have verified active users or transaction metrics to report. Our next milestone is to test the complete gift-and-claim journey with a small group of senders and recipients, measure where first-time users get stuck, and use that feedback to prioritize onboarding and security work.

### Who else is building in this space, and what are they getting wrong? (1000 characters)

Crypto gifting is being approached by products such as SolPay, exchange gift-card features like Binance Gift Card, and services such as Changelly GiftBox. They show that people want to share crypto or crypto-funded gifts, but the experience often centers on redeeming a code, using a specific platform, or buying a merchant gift card.

Solgift is exploring a narrower use case: a personal, customizable SOL or USDC gift on Solana, claimed from a shareable link through the recipient’s wallet. The problem we want to solve is the handoff to someone who may not already know how to receive crypto. We still need user testing to learn whether our approach removes enough friction and how it compares in practice.

### How do you make money, or plan to? (500 characters)

Our proposed model is a 5% fee paid by the sender, shown before the gift is funded. For example, a $10 gift would have a $0.50 fee. This is a hypothesis to validate, not a fee currently charged by the prototype. We will test whether senders consider the convenience and presentation worth the fee, and revisit pricing based on feedback and operating costs.

## Team, company, and fundraising

### How long have you each been working on this? Full-time? (500 characters)

[TODO: Add each founder’s start date and whether they work on Solgift full-time or part-time.]

### Where is each member based? Do you work in person? (500 characters)

[TODO: Add each team member’s city/country, whether the team works in person or remotely, and whether the arrangement would change after funding.]

### Legal entity details (800 characters)

[TODO: If incorporated, give the entity’s legal name, type, formation jurisdiction, and ownership split among founders and other stockholders. If not incorporated, change the form answer to “No.”]

### Investment details (800 characters)

[TODO: If the project has received investment, list each investor, amount and currency, instrument, and date. If it has not, change the form answer to “No.”]

### Current fundraising details

[TODO: If actively fundraising, state target amount, instrument or round, intended use of funds, and any investor interest or commitments. If not actively fundraising, change the form answer to “No.”]

### Live token

[TODO: Verify whether the project has a live token and answer Yes/No accurately.]

## Founder profile

### Educational background (500 characters)

[TODO: Add education, institution, field, and graduation year or current studies.]

### Previous work or projects (1000 characters)

[TODO: Add relevant roles, organizations/projects, what you personally built, and concrete outcomes.]

### Equity percentage

[TODO: Enter your actual agreed ownership percentage, or a good-faith estimate if not incorporated.]

### Full-time commitment

[TODO: Select Yes, Not yet, or No based on your current commitment and plans.]

### Most impressive thing built or accomplished outside Solgift (500 characters)

[TODO: Add a real accomplishment outside this project. Do not use Solgift for this field.]

### Why choose this project? (1000 characters)

I chose Solgift because sending crypto to someone new should feel like giving a gift, not walking them through a wallet transfer. I’m building a simple way to send SOL or USDC with a personal message and let the recipient claim it from a link. I want to make that first experience more approachable while building on Solana.

### A time you went to extreme lengths (500 characters)

[TODO: Describe a real situation: the challenge, the extra effort you personally made, and the result.]

### Technical background (600 characters)

I’m the technical builder behind Solgift. I’m developing the React/Vite application, integrating Solana Wallet Adapter for Phantom and Solflare, and building the SOL and USDC gift flows. I’m also working on the API and Anchor escrow program. The project is currently a Devnet prototype; the escrow and sponsored-claim flows still need coordinated deployment and end-to-end verification.

[Verify that each technical responsibility above is yours; remove anything you did not personally build.]

### Looking for a cofounder?

[TODO: Select Yes only if you are currently looking for a cofounder; otherwise select No.]

### LinkedIn profile

[TODO: Add your personal LinkedIn profile URL, usually https://www.linkedin.com/in/your-profile/ — not the /feed/ URL.]

## Links

- Live demo: https://solana-gift-vouchers-janbakutov0812-3514.vercel.app/
- GitHub: https://github.com/janbakutov0812-afk/solana-gift-vouchers
