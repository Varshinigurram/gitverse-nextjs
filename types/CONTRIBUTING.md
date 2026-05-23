# Contributing Guide

## Fork and Clone

```bash
git clone https://github.com/your-username/gitverse-nextjs.git
cd gitverse-nextjs
```

## Install Dependencies

```bash
npm install
```

## Run Development Server

```bash
npm run dev
```

## Required Environment Variables

Create a `.env.local` file in the root directory and add:

```env
DATABASE_URL=
JWT_SECRET=
NEXTAUTH_SECRET=
NEXTAUTH_URL=
GEMINI_API_KEY=
```

## Branch Naming Convention

Use meaningful branch names:

- fix/navbar-bug
- docs/update-readme
- feature/add-profile-page

## Pull Request Workflow

1. Fork repository
2. Create new branch
3. Make changes
4. Commit changes
5. Push branch
6. Open Pull Request

## Coding Standards

- Keep code clean and readable
- Follow existing folder structure
- Use descriptive naming conventions