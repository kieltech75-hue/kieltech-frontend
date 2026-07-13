# KielTech

A polished starter website for KielTech with:

- A public landing page for Vercel deployment
- A simple backend API for Render deployment
- An AI-style demo endpoint and contact form example

## Project structure

- Frontened/ - static site assets for Vercel
- Backened/ - Node.js API server for Render

## Run locally

Frontend:

```bash
cd Frontened
python -m http.server 3000
```

Backend:

```bash
cd Backened
node server.js
```

Then open:

- http://localhost:3000
- http://localhost:5000/api/health

## Deploy

- Deploy the Frontened folder to Vercel
- Deploy the Backened folder to Render
