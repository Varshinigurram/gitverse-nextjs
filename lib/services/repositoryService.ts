import prisma from "../prisma";
import { GitService } from "./gitService";
import { GitHubService } from "./githubService";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import * as fs from "fs/promises";

export interface AnalyzeRepositoryInput {
  name: string;
  url: string;
  description?: string;
  userId: number;
}

export type RepositoryAnalysisProgress = {
  progressPercent?: number;
  progressMessage?: string;
  progressDetails?: unknown;
};

export type RepositoryAnalysisProgressReporter = (
  update: RepositoryAnalysisProgress,
) => void | Promise<void>;

class AnalysisProgressTracker {
  constructor(
    private repositoryId: number,
    private reporter?: RepositoryAnalysisProgressReporter
  ) {}

  async update(percent: number, message: string, details?: unknown) {
    const safePercent = Math.max(0, Math.min(100, Math.round(percent || 0)));
    console.log(`[Repo ${this.repositoryId}] ${safePercent}% - ${message}`);
    
    if (!this.reporter) return;
    try {
      await this.reporter({
        progressPercent: safePercent,
        progressMessage: message,
        progressDetails: details,
      });
    } catch {
      // Progress reporting must never break analysis
    }
  }

  async progressSubTask(
    startPercent: number,
    endPercent: number,
    current: number,
    total: number,
    message: string
  ) {
    if (total <= 0) {
      await this.update(endPercent, `${message} (Completed)`);
      return;
    }
    const range = endPercent - startPercent;
    const ratio = Math.max(0, Math.min(1, current / total));
    const currentPercent = startPercent + (range * ratio);
    await this.update(currentPercent, message);
  }

  async fail(error: Error | unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error(`[Repo ${this.repositoryId}] Analysis Failed: ${msg}`);
    if (this.reporter) {
      try {
        await this.reporter({ progressMessage: `Failed: ${msg}` });
      } catch {}
    }
  }
}

export class RepositoryService {
  private async tryReadmeFromRepoPath(repoPath: string): Promise<{
    path: string;
    text: string;
  } | null> {
    const candidates = [
      "readme.md",
      "readme.markdown",
      "readme.mdx",
      "readme.txt",
      "readme.rst",
      "readme",
    ];

    try {
      const entries = await fs.readdir(repoPath, { withFileTypes: true });
      const fileNames = entries
        .filter((e) => e.isFile())
        .map((e) => e.name)
        .filter(Boolean);

      const byLower = new Map(fileNames.map((n) => [n.toLowerCase(), n]));

      for (const lower of candidates) {
        const actual = byLower.get(lower);
        if (!actual) continue;

        const fullPath = path.join(repoPath, actual);
        const content = await fs.readFile(fullPath, "utf8");
        const trimmed = content.trim();
        if (!trimmed) return null;

        // Prevent huge README payloads from bloating DB / responses.
        const maxChars = 200_000;
        const safeText =
          trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;

        return { path: actual, text: safeText };
      }

      return null;
    } catch {
      return null;
    }
  }

  async fetchAndStoreReadme(repositoryId: number, userId: number) {
    const repository = await prisma.repository.findFirst({
      where: { id: repositoryId, userId },
      select: { id: true, url: true },
    });

    if (!repository) {
      throw new Error("Repository not found");
    }

    const parsed = GitHubService.parseGitHubUrl(repository.url);
    if (parsed) {
      const account = await prisma.gitHubAccount.findUnique({
        where: { userId },
        select: { accessToken: true },
      });

      if (account?.accessToken) {
        const github = new GitHubService(account.accessToken);
        const readme = await github.getReadme(parsed.owner, parsed.repo);

        const updated = await prisma.repository.update({
          where: { id: repositoryId },
          data: {
            readmePath: readme?.path ?? "README.md",
            readmeText: readme?.text ?? "doesnt exist",
            readmeFetchedAt: new Date(),
          },
        });

        return updated;
      }
    }

    const tempDir = path.join(
      os.tmpdir(),
      "gitverse",
      `readme-${repositoryId}-${crypto.randomBytes(8).toString("hex")}`,
    );

    let gitService: GitService | null = null;

    try {
      gitService = await GitService.cloneRepository(repository.url, tempDir, {
        depth: 1,
        noSingleBranch: false,
      });

      const readme = await this.tryReadmeFromRepoPath(tempDir);

      const updated = await prisma.repository.update({
        where: { id: repositoryId },
        data: {
          readmePath: readme?.path ?? "README.md",
          readmeText: readme?.text ?? "doesnt exist",
          readmeFetchedAt: new Date(),
        },
      });

      return updated;
    } finally {
      if (gitService) {
        await gitService.cleanup();
      } else {
        await fs
          .rm(tempDir, { recursive: true, force: true })
          .catch(() => null);
      }
    }
  }

  /**
   * Create a new repository record or return existing one
   */
  async createRepository(input: AnalyzeRepositoryInput) {
    // Check if repository with same URL already exists for this user
    const existingRepository = await prisma.repository.findFirst({
      where: {
        url: input.url,
        userId: input.userId,
      },
    });

    if (existingRepository) {
      console.log(`Repository already exists: ${existingRepository.id}`);

      return existingRepository;
    }

    const repository = await prisma.repository.create({
      data: {
        name: input.name,
        url: input.url,
        description: input.description,
        userId: input.userId,
        status: "pending",
      },
    });

    return repository;
  }

  /**
   * Analyze a repository and store all data.
   * Uses GitHub API when the URL points to GitHub, avoiding a full git clone.
   */
  async analyzeRepository(
    repositoryId: number,
    opts?: { onProgress?: RepositoryAnalysisProgressReporter },
  ) {
    const repository = await prisma.repository.findUnique({
      where: { id: repositoryId },
    });

    if (!repository) {
      throw new Error("Repository not found");
    }

    // Update status to analyzing
    await prisma.repository.update({
      where: { id: repositoryId },
      data: { status: "analyzing" },
    });

    const tracker = new AnalysisProgressTracker(repositoryId, opts?.onProgress);
    await tracker.update(1, "Starting analysis");

    // Try to use GitHub API to avoid cloning.
    const parsed = GitHubService.parseGitHubUrl(repository.url);
    if (parsed) {
      const gitHubAccount = await prisma.gitHubAccount.findUnique({
        where: { userId: repository.userId },
        select: { accessToken: true },
      });

      if (!gitHubAccount?.accessToken) {
        throw new Error(
          "Please connect your GitHub account in Settings to analyze this repository.",
        );
      }

      await this.analyzeViaGitHubApi(
        repositoryId,
        parsed.owner,
        parsed.repo,
        gitHubAccount.accessToken,
        report,
      );
      return;
    }

    // Not a GitHub URL — give a clear message for non-GitHub repos.
    throw new Error(
      "Analysis via git clone is no longer supported. Only GitHub-hosted repositories can be analyzed. If this is a GitHub repo, ensure the URL is correct.",
    );

    // Legacy clone-based analysis is removed in favor of GitHub API.
  }

  /**
   * Analyze a GitHub repository via the GitHub API, without cloning.
   */
  private async analyzeViaGitHubApi(
    repositoryId: number,
    owner: string,
    repo: string,
    token: string,
    report: (update: RepositoryAnalysisProgress) => Promise<void>,
  ) {
    const github = new GitHubService(token);
    const repoFullName = `${owner}/${repo}`;

    // Get repository metadata
    await report({ progressPercent: 5, progressMessage: "Fetching repository info" });
    const repoInfo = await github.getRepository(owner, repo);
    if (!repoInfo) {
      throw new Error(`Repository ${repoFullName} not found on GitHub. It may have been deleted or access was lost.`);
    }

    const defaultBranch = repoInfo.default_branch || "main";
    const size = repoInfo.size * 1024; // GitHub returns KB, store as bytes

    // Get branches
    await report({ progressPercent: 10, progressMessage: "Fetching branches" });
    const gitBranches = await github.getBranches(owner, repo);
    const branchData = gitBranches.map((b) => ({
      name: b.name,
      isDefault: b.name === defaultBranch,
      isProtected: ["main", "master", "develop", "production"].includes(b.name),
      commitCount: 0,
      lastCommitAt: new Date(),
    }));

    if (branchData.length > 0) {
      await prisma.branch.createMany({
        data: branchData.map((b) => ({ ...b, repositoryId })),
        skipDuplicates: true,
      });
    }

    // Get commits (paginated)
    await report({ progressPercent: 20, progressMessage: "Fetching commits" });
    const rawCommits = await github.getCommitsAll(owner, repo, { maxCommits: 1000 });

    if (rawCommits.length > 0) {
      const existingCommits = await prisma.commit.findMany({
        where: { repositoryId, hash: { in: rawCommits.map((c) => c.sha) } },
        select: { hash: true },
      });
      const existingHashes = new Set(existingCommits.map((c) => c.hash));

      let insertedCount = 0;
      let failedCount = 0;
      let lastReport = Date.now();

      for (const c of rawCommits) {
        if (existingHashes.has(c.sha)) continue;

        try {
          await prisma.commit.create({
            data: {
              hash: c.sha,
              shortHash: c.sha.substring(0, 7),
              message: (c.commit?.message || "").split("\n")[0],
              description: c.commit?.message?.includes("\n") ? c.commit.message.substring(c.commit.message.indexOf("\n")).trim() : undefined,
              authorName: c.commit?.author?.name || "unknown",
              authorEmail: c.commit?.author?.email || "",
              committedAt: new Date(c.commit?.author?.date || Date.now()),
              branch: defaultBranch,
              parents: (c.parents || []).map((p: any) => p.sha),
              refs: [],
              tags: [],
              additions: c.stats?.additions ?? 0,
              deletions: c.stats?.deletions ?? 0,
              filesChanged: c.stats?.total ?? 0,
              repositoryId,
            },
          });

          insertedCount++;
          if (Date.now() - lastReport > 2000) {
            const pct = 20 + Math.round((insertedCount / rawCommits.length) * 35);
            await report({
              progressPercent: Math.min(60, pct),
              progressMessage: `Storing commits (${insertedCount}/${rawCommits.length})`,
            });
            lastReport = Date.now();
          }
        } catch (err: any) {
          failedCount++;
          console.error(`Failed to insert commit ${c.sha}:`, err.message);
        }
      }

      console.log(`Commits: ${insertedCount} inserted, ${failedCount} failed`);
    } else {
      console.log(`No commits found for ${repoFullName}`);
    }

    // Get file tree via GitHub API
    await report({ progressPercent: 65, progressMessage: "Scanning files" });
    const treeFiles = await github.getFileTree(owner, repo);

    if (treeFiles.length > 0) {
      const ignoredPatterns = [
        /node_modules\//,
        /\.git\//,
        /dist\//,
        /build\//,
        /out\//,
        /\.next\//,
        /coverage\//,
        /\.cache\//,
        /\.temp\//,
        /\.tmp\//,
        /package-lock\.json$/,
        /yarn\.lock$/,
        /pnpm-lock\.yaml$/,
        /\.lock$/,
        /\.log$/,
        /\.min\.js$/,
        /\.min\.css$/,
        /\.map$/,
        /\.bundle\.js$/,
      ];

      const extensionToLanguage: Record<string, string> = {
        ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
        ".ts": "TypeScript", ".tsx": "TypeScript",
        ".py": "Python", ".pyw": "Python",
        ".java": "Java",
        ".c": "C", ".h": "C", ".cpp": "C++", ".cc": "C++", ".hpp": "C++",
        ".cs": "C#",
        ".go": "Go",
        ".rs": "Rust",
        ".rb": "Ruby",
        ".php": "PHP",
        ".swift": "Swift",
        ".kt": "Kotlin",
        ".css": "CSS", ".scss": "SCSS", ".sass": "Sass", ".less": "Less",
        ".html": "HTML", ".htm": "HTML",
        ".json": "JSON", ".xml": "XML",
        ".yaml": "YAML", ".yml": "YAML", ".toml": "TOML",
        ".md": "Markdown", ".rst": "reStructuredText",
        ".sql": "SQL",
        ".vue": "Vue", ".svelte": "Svelte",
      };

      const fileRecords = [];
      for (const entry of treeFiles) {
        if (ignoredPatterns.some((p) => p.test(entry.path))) continue;
        const ext = path.extname(entry.path).toLowerCase();
        const lines = entry.size > 0 ? Math.max(1, Math.ceil(entry.size / 80)) : 0;
        fileRecords.push({
          path: entry.path,
          name: path.basename(entry.path),
          extension: ext || null,
          size: entry.size,
          lines,
          language: extensionToLanguage[ext] || null,
          repositoryId,
        });
      }

      if (fileRecords.length > 0) {
        const chunkSize = 500;
        for (let i = 0; i < fileRecords.length; i += chunkSize) {
          const chunk = fileRecords.slice(i, i + chunkSize);
          await prisma.file.createMany({ data: chunk, skipDuplicates: true });
          await report({
            progressPercent: 65 + Math.round((Math.min(fileRecords.length, i + chunkSize) / fileRecords.length) * 10),
            progressMessage: `Storing files (${Math.min(fileRecords.length, i + chunkSize)}/${fileRecords.length})`,
          });
        }
      }
    }

    // Get contributors
    await report({ progressPercent: 80, progressMessage: "Analyzing contributors" });
    const apiContributors = await github.getContributorsAll(owner, repo);

    if (apiContributors.length > 0) {
      await prisma.contributor.createMany({
        data: apiContributors.map((c) => ({
          name: c.login,
          email: "",
          commits: c.contributions,
          additions: 0,
          deletions: 0,
          percentage: 0,
          firstCommit: new Date(0),
          lastCommit: new Date(0),
          repositoryId,
        })),
        skipDuplicates: true,
      });
    }

    // Get languages
    await report({ progressPercent: 90, progressMessage: "Detecting languages" });
    const languageBytes = await github.getLanguages(owner, repo);
    const ignoredLanguages = ["JSON", "YAML", "Markdown", "TOML", "CSV"];
    const totalBytes = Object.values(languageBytes).reduce((s, v) => s + v, 0);

    if (totalBytes > 0) {
      const langEntries = Object.entries(languageBytes)
        .filter(([name]) => !ignoredLanguages.includes(name))
        .map(([name, bytes]) => ({
          name,
          bytes,
          percentage: Math.round((bytes / totalBytes) * 10000) / 100,
        }));

      if (langEntries.length > 0) {
        // Ensure sum is exactly 100
        const sum = langEntries.reduce((s, l) => s + l.percentage, 0);
        if (sum > 0 && sum !== 100) {
          const diff = 100 - sum;
          const maxIdx = langEntries.indexOf(langEntries.reduce((a, b) => a.percentage > b.percentage ? a : b));
          langEntries[maxIdx].percentage = Math.round((langEntries[maxIdx].percentage + diff) * 100) / 100;
        }

        await prisma.language.deleteMany({ where: { repositoryId } });
        await prisma.language.createMany({
          data: langEntries.map((l) => ({ ...l, lines: 0, repositoryId })),
          skipDuplicates: true,
        });
      }
    }

    // Update repository with final data
    await prisma.repository.update({
      where: { id: repositoryId },
      data: {
        status: "completed",
        lastAnalyzedAt: new Date(),
        defaultBranch,
        size,
      },
    });

    await report({ progressPercent: 100, progressMessage: "Completed" });
  }

  /**
   * Safely marks a repository as failed, preventing uncaught exceptions
   * if the database update fails.
   */
  async markRepositoryFailed(id: number, reason?: string) {
    try {
      await prisma.repository.update({
        where: { id },
        data: { status: "failed" },
      });
      if (reason) {
        console.log(`Repository ${id} marked as failed. Reason: ${reason}`);
      }
    } catch (error) {
      console.error(`Safeguard: Failed to update repository ${id} status to 'failed'`, error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Get repository with all related data
   */
  async getRepository(id: number, userId: number) {
    const repository = await prisma.repository.findFirst({
      where: {
        id,
        userId,
      },
      include: {
        branches: {
          orderBy: { isDefault: "desc" },
        },
        commits: {
          orderBy: { committedAt: "desc" },
          take: 100,
          include: {
            fileChanges: true,
          },
        },
        contributors: {
          orderBy: { commits: "desc" },
        },
        languages: {
          orderBy: { percentage: "desc" },
        },
        files: {
          orderBy: { path: "asc" },
          take: 500,
        },
      },
    });

    return repository;
  }

  /**
   * List all repositories for a user
   */
  async listRepositories(userId: number) {
    const repositories = await prisma.repository.findMany({
      where: { userId },
      include: {
        _count: {
          select: {
            commits: true,
            contributors: true,
            files: true,
            branches: true,
          },
        },
        languages: {
          orderBy: { percentage: "desc" },
          take: 3,
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return repositories;
  }

  /**
   * Delete a repository and all its data
   */
  async deleteRepository(id: number, userId: number) {
    const repository = await prisma.repository.findFirst({
      where: { id, userId },
    });

    if (!repository) {
      throw new Error("Repository not found");
    }

    // Delete related analysis jobs and the repository in a transaction
    // to ensure no orphaned rows remain if the process is interrupted.
    await prisma.$transaction([
      prisma.analysisJob.deleteMany({
        where: { repositoryId: id },
      }),
      prisma.repository.delete({
        where: { id },
      }),
    ]);

    return { success: true };
  }

  /**
   * Get repository statistics
   */
  async getRepositoryStats(id: number, userId: number) {
    const repository = await prisma.repository.findFirst({
      where: { id, userId },
    });

    if (!repository) {
      throw new Error("Repository not found");
    }

    const [
      totalCommits,
      totalContributors,
      totalFiles,
      totalBranches,
      recentActivity,
    ] = await Promise.all([
      prisma.commit.count({ where: { repositoryId: id } }),
      prisma.contributor.count({ where: { repositoryId: id } }),
      prisma.file.count({ where: { repositoryId: id } }),
      prisma.branch.count({ where: { repositoryId: id } }),
      prisma.commit.findMany({
        where: { repositoryId: id },
        orderBy: { committedAt: "desc" },
        take: 10,
        select: {
          shortHash: true,
          message: true,
          authorName: true,
          committedAt: true,
        },
      }),
    ]);

    return {
      totalCommits,
      totalContributors,
      totalFiles,
      totalBranches,
      recentActivity,
      status: repository.status,
      lastAnalyzedAt: repository.lastAnalyzedAt,
    };
  }
}

export const repositoryService = new RepositoryService();
interface GetRepositoriesOptions {
  userId: number;
  limit: number;
  cursor?: string;
}

export async function getRepositories({ userId, limit, cursor }: GetRepositoriesOptions) {
  const cursorId = cursor ? parseInt(cursor.trim(), 10) : undefined;
if (cursor && (!/^[1-9]\d*$/.test(cursor.trim()) || isNaN(cursorId!))) {
  throw new Error("Invalid cursor value");
}

  return prisma.repository.findMany({
    where: { userId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    include: {
      _count: {
        select: {
          commits: true,
          contributors: true,
          files: true,
          branches: true,
        },
      },
      languages: {
        orderBy: { percentage: "desc" },
        take: 3,
      },
    },
  });
}