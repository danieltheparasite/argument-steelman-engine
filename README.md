# Argument Steelman Engine

Enter a claim and choose a mode: **Strengthen my argument** or **Steelman the other side**. The app builds the argument in three stages (Baseline, Strengthened, Steelman), shows the weaknesses and objections found at each step, scores each stage out of 12, and reports logical fallacies per stage. Gemma 4, called through the Gemini API, does all of the analysis.

## Setup
1. Install Node.js 20+ from nodejs.org.
2. `npm install` installs the dependencies.
3. `cp .env.example .env.local` creates your private settings file. Open `.env.local` and paste your key after `GEMINI_API_KEY=` (create one at https://aistudio.google.com/apikey).
4. `AI_MODEL` defaults to `gemma-4-26b-a4b-it`; set `gemma-4-31b-it` for the larger model. Check the current ids in the [Gemma on Gemini API docs](https://ai.google.dev/gemma/docs/core/gemma_on_gemini_api).
5. `npm run dev` starts the app at http://localhost:3000.

## How Gemma powers the application
The browser posts the claim to `/api/steelman`. The server sends one structured request to Gemma, which classifies the claim, finds fallacies, writes the baseline, critiques it, strengthens it twice, and scores each stage. The server validates the JSON with Zod, recomputes every total itself, and returns it to the UI.

## What the UI shows
How the claim was interpreted and its type, per-stage weaknesses, objections and improvements, evidence you would need to verify, scores out of 12 (totals computed server-side), and fallacies with the exact flagged phrase underlined in the text. Drafts appear as Gemma writes them (streamed). Stress-test scraps (a strong claim, a false dilemma, a vague claim) show it declining to flatter; a cached example run works without the API. Results export as Markdown or a PNG card. A 26B/31B toggle switches Gemma sizes.

## Evaluate
`npm run dev`, then `npm run eval` (or `node scripts/eval.mjs https://your-site`). It checks stage count, totals, score ranges, that every flagged excerpt really appears in the text, no invented URLs, and a few expected behaviours. Model output varies, so treat failures as prompts to review.

## Architecture
- `public/desk.html`: the UI (served at `/`). It posts the claim to `/api/steelman`.
- `app/api/steelman/route.ts`: validates the request and maps errors. Never leaks keys or stack traces.
- `lib/ai.ts`: the only provider-specific file. Calls Gemma once, validates with Zod, computes totals itself.
- `lib/prompts.ts`, `lib/schema.ts`: compact prompt and the JSON schema sent to the model.

## Security
The API key lives only in `.env.local` or Vercel environment variables, is read on the server, and `.env.local` is git-ignored.

## GitHub
`git init` starts a repository; `git add .` stages files; `git commit -m "Initial commit"` saves them; `git branch -M main` names the branch; `git remote add origin YOUR_GITHUB_REPOSITORY_URL` links GitHub; `git push -u origin main` uploads.

## Vercel
Push to GitHub, import the repo at vercel.com, add `GEMINI_API_KEY` and `AI_MODEL` under Environment Variables, deploy, then submit a claim on the live site.

## Troubleshooting
- "missing GEMINI_API_KEY": restart `npm run dev` after editing `.env.local`.
- "returned no result": check the `AI_MODEL` id against the docs.
- Rate limit: wait and retry.

## Deployment notes
The rate limiter and cache are in-memory per server instance, so on Vercel they are best-effort only. Use a shared store (Vercel KV/Upstash) before exposing a public key to real traffic. Gemma has open weights, so a local (e.g. Ollama) provider could replace `lib/ai.ts`; that is not implemented here.

## Limitations
Model output can be wrong; fallacy classification is probabilistic; no detected fallacy does not prove soundness; evidence claims need external verification; this is an analytical aid, not an authority on truth.

## License
Application code: Apache-2.0 (add the full text from apache.org/licenses/LICENSE-2.0.txt as `LICENSE`). Gemma is governed by its own terms; dependencies by theirs. Not affiliated with or endorsed by Google.
