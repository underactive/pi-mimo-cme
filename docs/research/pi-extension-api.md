# Pi Extension API Reference — for a Persistent Memory Extension (SQLite FTS5)

Target: **Pi v0.79.1**, package `@earendil-works/pi-coding-agent` (Mario Zechner / Earendil Works; repo `github.com/earendil-works/pi-mono`, docs at pi.dev).

**Ground truth used** (all confirmed from local v0.79.1 install unless marked otherwise):

- Binary: `/Users/esison/.nvm/versions/node/v24.4.0/bin/pi` → `/Users/esison/.nvm/versions/node/v24.4.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js` (shebang `#!/usr/bin/env node`, runs under **Node v24.4.0** here)
- Types: `<pkg>/dist/core/extensions/types.d.ts` (the extension API), `<pkg>/dist/config.d.ts`, `<pkg>/dist/core/messages.d.ts`, `<pkg>/dist/core/session-manager.d.ts`, `<pkg>/node_modules/@earendil-works/pi-ai/dist/types.d.ts`, `<pkg>/node_modules/@earendil-works/pi-agent-core/dist/types.d.ts`
- Docs shipped *inside* the installed package (same version): `<pkg>/docs/extensions.md`, `settings.md`, `packages.md`
- Examples shipped inside the package: `<pkg>/examples/extensions/` (~80 working examples)
- `https://pi.dev/docs/latest/extensions` (matches local docs)

Where `<pkg>` = `/Users/esison/.nvm/versions/node/v24.4.0/lib/node_modules/@earendil-works/pi-coding-agent`.

> Note: the package was historically `@mariozechner/pi`; v0.79.1 is published as `@earendil-works/pi-coding-agent`. All imports in extensions use `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, `typebox`.

---

## 1. Discovery & Loading (confirmed: `dist/core/extensions/loader.js`, docs/extensions.md)

Extensions are auto-discovered from trusted locations:

| Location | Scope |
|----------|-------|
| `~/.pi/agent/extensions/*.ts` (or `*.js`) | Global (all projects) |
| `~/.pi/agent/extensions/*/index.ts` (or `index.js`) | Global (subdirectory style) |
| `~/.pi/agent/extensions/*/package.json` with `"pi": { "extensions": [...] }` | Global (package style) |
| `.pi/extensions/*.ts`, `*/index.ts`, `*/package.json` | Project-local (loads only after project is trusted) |

Loader logic (verbatim comment from `loader.js`):
```
 * 1. Direct files: `extensions/*.ts` or `*.js` → load
 * 2. Subdirectory with index: `extensions/* /index.ts` or `index.js` → load
 * 3. Subdirectory with package.json: `extensions/* /package.json` with "pi" field → load what it declares
```

Additional paths via `settings.json` (`~/.pi/agent/settings.json` global, `.pi/settings.json` project):

```json
{
  "packages": ["npm:@foo/bar@1.0.0", "git:github.com/user/repo@v1"],
  "extensions": ["/path/to/local/extension.ts", "/path/to/local/extension/dir"]
}
```

CLI:
- `pi --extension ./ext.ts` / `pi -e ./ext.ts` (repeatable) — quick test loading
- `pi --no-extensions` / `-ne` — disable discovery (explicit `-e` still works)
- `pi install <source> [-l]`, `pi remove`, `pi update`, `pi list`, `pi config` — package management (`-l` = project settings). npm packages install under `~/.pi/agent/npm/`, git clones under `~/.pi/agent/git/<host>/<path>`.
- `/reload` in the TUI hot-reloads extensions from auto-discovered locations.

**How TypeScript runs**: pi runs under plain **Node** (or a compiled Bun binary distribution — this install is Node). Extensions are loaded with **jiti** (verbatim from `loader.js`):

```js
import { createJiti } from "jiti/static";
const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    ...(isBunBinary ? { virtualModules: VIRTUAL_MODULES, tryNative: false } : { alias: getAliases() }),
});
const module = await jiti.import(extensionPath, { default: true });
```

So: **TS works without any compilation step**, no tsx/bun needed. `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, and `typebox` are aliased to pi's own node_modules, so you can import them without installing anything. Node built-ins (`node:fs`, `node:path`, **`node:sqlite`**) are available.

**npm dependencies for extensions** (docs/extensions.md, confirmed by `examples/extensions/with-deps/`): put a `package.json` next to your extension (or in a parent directory), run `npm install`, and imports resolve from that `node_modules/` automatically. Package-style layout:

```
~/.pi/agent/extensions/
└── my-extension/
    ├── package.json    # { "pi": { "extensions": ["./src/index.ts"] }, "dependencies": {...} }
    ├── package-lock.json
    ├── node_modules/
    └── src/index.ts
```

For distributed packages (`pi install`), runtime deps must be in `dependencies` (installs use `npm install --omit=dev`).

Symlinks into `~/.pi/agent/extensions/` work (the user's existing setup symlinks `exit-stats.ts` and `cursor-agent.js` there — observed locally).

---

## 2. Entry Point (confirmed: types.d.ts)

```typescript
/** Extension factory function type. Supports both sync and async initialization. */
export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;
```

An extension is a module whose **default export** is that factory:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (event, ctx) => { /* ... */ });
  pi.registerTool({ /* ... */ });
  pi.registerCommand("name", { /* ... */ });
}
```

Async factories are awaited before startup continues (before `session_start` and `resources_discover`).

**Lifecycle gotcha**: on `/new`, `/resume`, `/fork`, `/reload` the old extension runtime gets `session_shutdown`, then extensions are **re-loaded and re-bound**, then `session_start` fires with the appropriate `reason`. Do cleanup (e.g. close SQLite handle) in `session_shutdown`; (re)open and re-inject in `session_start` / `before_agent_start`. Module-level state does not survive replacement.

---

## 3. Full Event Surface (verbatim from `dist/core/extensions/types.d.ts`)

The `pi.on(...)` overloads — this is the complete event list in v0.79.1:

```typescript
export interface ExtensionAPI {
    on(event: "project_trust", handler: ProjectTrustHandler): void;
    on(event: "resources_discover", handler: ExtensionHandler<ResourcesDiscoverEvent, ResourcesDiscoverResult>): void;
    on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
    on(event: "session_before_switch", handler: ExtensionHandler<SessionBeforeSwitchEvent, SessionBeforeSwitchResult>): void;
    on(event: "session_before_fork", handler: ExtensionHandler<SessionBeforeForkEvent, SessionBeforeForkResult>): void;
    on(event: "session_before_compact", handler: ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>): void;
    on(event: "session_compact", handler: ExtensionHandler<SessionCompactEvent>): void;
    on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): void;
    on(event: "session_before_tree", handler: ExtensionHandler<SessionBeforeTreeEvent, SessionBeforeTreeResult>): void;
    on(event: "session_tree", handler: ExtensionHandler<SessionTreeEvent>): void;
    on(event: "context", handler: ExtensionHandler<ContextEvent, ContextEventResult>): void;
    on(event: "before_provider_request", handler: ExtensionHandler<BeforeProviderRequestEvent, BeforeProviderRequestEventResult>): void;
    on(event: "after_provider_response", handler: ExtensionHandler<AfterProviderResponseEvent>): void;
    on(event: "before_agent_start", handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>): void;
    on(event: "agent_start", handler: ExtensionHandler<AgentStartEvent>): void;
    on(event: "agent_end", handler: ExtensionHandler<AgentEndEvent>): void;
    on(event: "turn_start", handler: ExtensionHandler<TurnStartEvent>): void;
    on(event: "turn_end", handler: ExtensionHandler<TurnEndEvent>): void;
    on(event: "message_start", handler: ExtensionHandler<MessageStartEvent>): void;
    on(event: "message_update", handler: ExtensionHandler<MessageUpdateEvent>): void;
    on(event: "message_end", handler: ExtensionHandler<MessageEndEvent, MessageEndEventResult>): void;
    on(event: "tool_execution_start", handler: ExtensionHandler<ToolExecutionStartEvent>): void;
    on(event: "tool_execution_update", handler: ExtensionHandler<ToolExecutionUpdateEvent>): void;
    on(event: "tool_execution_end", handler: ExtensionHandler<ToolExecutionEndEvent>): void;
    on(event: "model_select", handler: ExtensionHandler<ModelSelectEvent>): void;
    on(event: "thinking_level_select", handler: ExtensionHandler<ThinkingLevelSelectEvent>): void;
    on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): void;
    on(event: "tool_result", handler: ExtensionHandler<ToolResultEvent, ToolResultEventResult>): void;
    on(event: "user_bash", handler: ExtensionHandler<UserBashEvent, UserBashEventResult>): void;
    on(event: "input", handler: ExtensionHandler<InputEvent, InputEventResult>): void;
    // ... (registration methods below)
}

/** Handler function type for events */
export type ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;
```

Lifecycle order (verbatim diagram excerpt from docs/extensions.md):

```
pi starts
  ├─► project_trust
  ├─► session_start { reason: "startup" }
  └─► resources_discover { reason: "startup" }
user sends prompt
  ├─► input (can intercept, transform, or handle)
  ├─► before_agent_start (can inject message, modify system prompt)
  ├─► agent_start
  ├─► message_start / message_update / message_end
  │   turn (repeats while LLM calls tools):
  │     turn_start → context (can modify messages) → before_provider_request
  │     → after_provider_response
  │     tools: tool_execution_start → tool_call (can block) → tool_execution_update
  │            → tool_result (can modify) → tool_execution_end
  │     turn_end
  └─► agent_end
exit (Ctrl+C, Ctrl+D, SIGHUP, SIGTERM)
  └─► session_shutdown
```

### 3a. Key event payloads (verbatim from types.d.ts)

```typescript
/** Fired when a session is started, loaded, or reloaded */
export interface SessionStartEvent {
    type: "session_start";
    /** Why this session start happened. */
    reason: "startup" | "reload" | "new" | "resume" | "fork";
    /** Previously active session file. Present for "new", "resume", and "fork". */
    previousSessionFile?: string;
}

/** Fired before an extension runtime is torn down due to quit, reload, or session replacement. */
export interface SessionShutdownEvent {
    type: "session_shutdown";
    reason: "quit" | "reload" | "new" | "resume" | "fork";
    targetSessionFile?: string;
}

/** Fired after user submits prompt but before agent loop. */
export interface BeforeAgentStartEvent {
    type: "before_agent_start";
    /** The raw user prompt text (after expansion). */
    prompt: string;
    /** Images attached to the user prompt, if any. */
    images?: ImageContent[];
    /** The fully assembled system prompt string. */
    systemPrompt: string;
    /** Structured options used to build the system prompt. */
    systemPromptOptions: BuildSystemPromptOptions;
}
export interface BeforeAgentStartEventResult {
    message?: Pick<CustomMessage, "customType" | "content" | "display" | "details">;
    /** Replace the system prompt for this turn. If multiple extensions return this, they are chained. */
    systemPrompt?: string;
}

/** Fired when an agent loop ends */
export interface AgentEndEvent {
    type: "agent_end";
    messages: AgentMessage[];
}

/** Fired at the end of each turn */
export interface TurnEndEvent {
    type: "turn_end";
    turnIndex: number;
    message: AgentMessage;
    toolResults: ToolResultMessage[];
}

/** Fired when a message starts (user, assistant, or toolResult) */
export interface MessageStartEvent { type: "message_start"; message: AgentMessage; }
/** Fired when a message ends */
export interface MessageEndEvent { type: "message_end"; message: AgentMessage; }
export interface MessageEndEventResult {
    /** Replace the finalized message. The replacement must keep the original message role. */
    message?: AgentMessage;
}

/** Fired before each LLM call. Can modify messages. */
export interface ContextEvent { type: "context"; messages: AgentMessage[]; }
export interface ContextEventResult { messages?: AgentMessage[]; }

export interface ToolCallEventResult {
    /** Block tool execution. To modify arguments, mutate `event.input` in place instead. */
    block?: boolean;
    reason?: string;
}
export interface ToolResultEventResult {
    content?: (TextContent | ImageContent)[];
    details?: unknown;
    isError?: boolean;
}

/** Fired when user input is received, before agent processing */
export interface InputEvent {
    type: "input";
    text: string;
    images?: ImageContent[];
    source: "interactive" | "rpc" | "extension";
    streamingBehavior?: "steer" | "followUp";
}
export type InputEventResult =
    | { action: "continue" }
    | { action: "transform"; text: string; images?: ImageContent[] }
    | { action: "handled" };
```

`ToolCallEvent` is a discriminated union (`BashToolCallEvent | ReadToolCallEvent | EditToolCallEvent | WriteToolCallEvent | GrepToolCallEvent | FindToolCallEvent | LsToolCallEvent | CustomToolCallEvent`), each `{ type: "tool_call"; toolCallId: string; toolName: ...; input: ... }`. Narrow with the exported guard `isToolCallEventType("bash", event)` etc. (direct `event.toolName === "bash"` does NOT narrow because `CustomToolCallEvent.toolName` is `string`).

### 3b. INJECTING context at session start (the memory-injection answer)

Two complementary mechanisms:

1. **`before_agent_start`** — fires on every user prompt; return `{ systemPrompt: event.systemPrompt + "\n\n## Memories\n..." }` to append to the system prompt for that turn (chained across extensions), and/or `{ message: { customType, content, display } }` to inject a **persistent** custom message into the session that is sent to the LLM. This is the idiomatic injection point (see `examples/extensions/pirate.ts` and `claude-rules.ts`). There is no separate "modify system prompt at session_start" API — `session_start` is where you *load* state; `before_agent_start` is where you *inject* it per turn.
2. **`context` event** — fires before *every* LLM call; return `{ messages }` to add/filter/rewrite the message array non-destructively (the array is a deep copy). Useful for injecting retrieved memories adjacent to the latest user message without persisting them.
3. `pi.sendMessage({ customType, content, display }, { deliverAs: "nextTurn" })` — queue a custom message stored in the session and sent to the LLM.

### 3c. OBSERVING the conversation (the memory-extraction answer)

- **`message_end`** — fires once per finalized message for **user, assistant, and toolResult** roles. Check `event.message.role`. This is the cleanest single hook to capture both sides of the conversation.
- **`agent_end`** — `event.messages: AgentMessage[]` gives all messages from the just-finished prompt cycle (good for batched extraction once the agent goes idle).
- **`turn_end`** — per-turn assistant message + tool results.
- On `session_start` you can replay history: `ctx.sessionManager.getBranch()` / `getEntries()` returns `SessionEntry[]`, where message entries are `{ type: "message", message: AgentMessage }`.

Message shapes (verbatim from `@earendil-works/pi-ai` `dist/types.d.ts`):

```typescript
export interface UserMessage {
    role: "user";
    content: string | (TextContent | ImageContent)[];
    timestamp: number;
}
export interface AssistantMessage {
    role: "assistant";
    content: (TextContent | ThinkingContent | ToolCall)[];
    api: Api; provider: Provider; model: string;
    responseModel?: string; responseId?: string;
    diagnostics?: AssistantMessageDiagnostic[];
    usage: Usage; stopReason: StopReason; errorMessage?: string;
    timestamp: number;
}
export interface ToolResultMessage<TDetails = any> {
    role: "toolResult";
    toolCallId: string; toolName: string;
    content: (TextContent | ImageContent)[];
    details?: TDetails; isError: boolean; timestamp: number;
}
export type Message = UserMessage | AssistantMessage | ToolResultMessage;
```

`AgentMessage = Message | BashExecutionMessage | CustomMessage | BranchSummaryMessage | CompactionSummaryMessage` (custom roles registered via declaration merging in `dist/core/messages.d.ts`; `CustomMessage` has `role: "custom"`, `customType: string`, `content`, `display: boolean`, `details?`, `timestamp`). When extracting text, handle `typeof content === "string"` (user) vs content-part arrays; assistant text parts are `{ type: "text", text }`. The helper `convertToLlm(messages)` (exported from the package) flattens custom roles to LLM messages.

---

## 4. Registering a Custom Tool (confirmed: types.d.ts + docs)

Schema flavor: **TypeBox** (`typebox` v1.1.38, aliased — `import { Type } from "typebox"`; also re-exported as `Type` from `@earendil-works/pi-ai`). NOT zod, NOT raw JSON schema.

```typescript
/** Tool definition for registerTool(). (verbatim, abridged comments) */
export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown, TState = any> {
    name: string;                       // Tool name (used in LLM tool calls)
    label: string;                      // Human-readable label for UI
    description: string;                // Description for LLM
    promptSnippet?: string;             // one-line entry in "Available tools" section of system prompt
    promptGuidelines?: string[];        // bullets appended to system prompt Guidelines while tool active
    parameters: TParams;                // Parameter schema (TypeBox)
    renderShell?: "default" | "self";
    prepareArguments?: (args: unknown) => Static<TParams>;   // pre-validation shim
    executionMode?: ToolExecutionMode;  // "sequential" | "parallel" (default mode is parallel)
    execute(toolCallId: string, params: Static<TParams>, signal: AbortSignal | undefined,
            onUpdate: AgentToolUpdateCallback<TDetails> | undefined, ctx: ExtensionContext): Promise<AgentToolResult<TDetails>>;
    renderCall?: (args: Static<TParams>, theme: Theme, context: ToolRenderContext<TState, Static<TParams>>) => Component;
    renderResult?: (result: AgentToolResult<TDetails>, options: ToolRenderResultOptions, theme: Theme,
                    context: ToolRenderContext<TState, Static<TParams>>) => Component;
}

registerTool<TParams extends TSchema = TSchema, TDetails = unknown, TState = any>(tool: ToolDefinition<TParams, TDetails, TState>): void;

export declare function defineTool<TParams extends TSchema, TDetails = unknown, TState = any>(
    tool: ToolDefinition<TParams, TDetails, TState>): ToolDefinition<TParams, TDetails, TState> & AnyToolDefinition;
```

Return value shape (verbatim from `@earendil-works/pi-agent-core`):

```typescript
export interface AgentToolResult<T> {
    /** Text or image content returned to the model. */
    content: (TextContent | ImageContent)[];
    /** Arbitrary structured details for logs or UI rendering. */
    details: T;
    /** Hint that the agent should stop after the current tool batch. */
    terminate?: boolean;
}
export type AgentToolUpdateCallback<T = any> = (partialResult: AgentToolResult<T>) => void;
```

Rules:
- **Throw** from `execute` to signal an error (`isError: true` to the LLM). Returning a value never sets the error flag.
- Use `StringEnum([...] as const)` from `@earendil-works/pi-ai` for string enums (`Type.Union`/`Type.Literal` breaks Google's API).
- **Truncate output**: built-in limit is 50KB / 2000 lines. Helpers exported from the package: `truncateHead`, `truncateTail`, `truncateLine`, `formatSize`, `DEFAULT_MAX_BYTES`, `DEFAULT_MAX_LINES`.
- `registerTool` works during load AND later (e.g. inside `session_start` or command handlers) — tools refresh immediately without `/reload`.
- Tools run in **parallel** by default; set `executionMode: "sequential"` if your tool mutates shared state (a single SQLite connection is fine — `node:sqlite` DatabaseSync is synchronous — but sequential is safer for write-ordering semantics). If a tool mutates files, wrap in `withFileMutationQueue(absPath, fn)`.
- `promptGuidelines` bullets must name the tool ("Use memory_save when..." not "Use this tool when...").

Minimal verbatim example (`examples/extensions/hello.ts`):

```typescript
/**
 * Hello Tool - Minimal custom tool example
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const helloTool = defineTool({
	name: "hello",
	label: "Hello",
	description: "A simple greeting tool",
	parameters: Type.Object({
		name: Type.String({ description: "Name to greet" }),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		return {
			content: [{ type: "text", text: `Hello, ${params.name}!` }],
			details: { greeted: params.name },
		};
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(helloTool);
}
```

---

## 5. Slash Commands, Shortcuts, Flags (confirmed: types.d.ts)

```typescript
registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void;

export interface RegisteredCommand {
    name: string;
    sourceInfo: SourceInfo;
    description?: string;
    getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

registerShortcut(shortcut: KeyId, options: { description?: string; handler: (ctx: ExtensionContext) => Promise<void> | void; }): void;
registerFlag(name: string, options: { description?: string; type: "boolean" | "string"; default?: boolean | string; }): void;
getFlag(name: string): boolean | string | undefined;
```

Example:
```typescript
pi.registerCommand("memory", {
  description: "Search or manage memories",
  getArgumentCompletions: (prefix) => ["search", "list", "forget"].filter(s => s.startsWith(prefix)).map(v => ({ value: v, label: v })),
  handler: async (args, ctx) => { ctx.ui.notify(`memory ${args}`, "info"); },
});
```

Command handlers get `ExtensionCommandContext` (adds `waitForIdle()`, `newSession()`, `fork()`, `navigateTree()`, `switchSession()`, `reload()`, `getSystemPromptOptions()` on top of `ExtensionContext`). Duplicate command names across extensions get suffixes (`/review:1`).

---

## 6. ExtensionAPI — other methods you'll use (verbatim signatures)

```typescript
/** Send a custom message to the session. */
sendMessage<T = unknown>(message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn"; }): void;

/** Send a user message to the agent. Always triggers a turn. */
sendUserMessage(content: string | (TextContent | ImageContent)[], options?: { deliverAs?: "steer" | "followUp"; }): void;

/** Append a custom entry to the session for state persistence (not sent to LLM). */
appendEntry<T = unknown>(customType: string, data?: T): void;

setSessionName(name: string): void;
getSessionName(): string | undefined;
setLabel(entryId: string, label: string | undefined): void;

/** Execute a shell command. */
exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;  // result.stdout, .stderr, .code, .killed

getActiveTools(): string[];
getAllTools(): ToolInfo[];
setActiveTools(toolNames: string[]): void;
getCommands(): SlashCommandInfo[];
setModel(model: Model<any>): Promise<boolean>;
getThinkingLevel(): ThinkingLevel;     // "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
setThinkingLevel(level: ThinkingLevel): void;
registerMessageRenderer<T = unknown>(customType: string, renderer: MessageRenderer<T>): void;
registerProvider(name: string, config: ProviderConfig): void;
unregisterProvider(name: string): void;
/** Shared event bus for extension communication. */
events: EventBus;
```

## 7. ExtensionContext (verbatim, abridged)

```typescript
export type ExtensionMode = "tui" | "rpc" | "json" | "print";
export interface ExtensionContext {
    ui: ExtensionUIContext;            // dialogs, notify, status, widgets
    mode: ExtensionMode;
    hasUI: boolean;                    // true in TUI and RPC modes
    cwd: string;
    sessionManager: ReadonlySessionManager;
    modelRegistry: ModelRegistry;
    model: Model<any> | undefined;
    isIdle(): boolean;
    isProjectTrusted(): boolean;
    signal: AbortSignal | undefined;   // abort signal during active turns
    abort(): void;
    hasPendingMessages(): boolean;
    shutdown(): void;
    getContextUsage(): ContextUsage | undefined;
    compact(options?: CompactOptions): void;
    getSystemPrompt(): string;
}
```

`ReadonlySessionManager` = `Pick<SessionManager, "getCwd" | "getSessionDir" | "getSessionId" | "getSessionFile" | "getLeafId" | "getLeafEntry" | "getEntry" | "getLabel" | "getBranch" | "getHeader" | "getEntries" | "getTree" | "getSessionName">` (verbatim from `session-manager.d.ts`). `SessionEntry` union includes `SessionMessageEntry { type: "message"; message: AgentMessage }` and `CustomEntry<T> { type: "custom"; customType: string; data?: T }`.

---

## 8. Storage Conventions — where to put the SQLite DB

There is **no dedicated per-extension storage API**. Confirmed conventions:

- **`getAgentDir()`** is exported from `@earendil-works/pi-coding-agent` (verbatim from `dist/config.js`):
  ```js
  export function getAgentDir() {
      const envDir = process.env[ENV_AGENT_DIR];   // "PI_CODING_AGENT_DIR"
      if (envDir) return expandTildePath(envDir);
      return join(homedir(), CONFIG_DIR_NAME, "agent");   // CONFIG_DIR_NAME = ".pi"
  }
  ```
  → defaults to **`~/.pi/agent/`**. Pi itself stores `auth.json`, `models.json`, `settings.json`, `keybindings.json`, `sessions/`, `extensions/`, `skills/`, `npm/`, `bin/` there (observed locally in `~/.pi/agent/`).
- **Recommended global DB location**: `path.join(getAgentDir(), "memory", "memory.db")` (i.e. `~/.pi/agent/memory/memory.db`), created with `fs.mkdirSync(dir, { recursive: true })`. Respecting `getAgentDir()` keeps you compatible with the `PI_CODING_AGENT_DIR` override.
- **Per-project**: `.pi/` in the project root is the project config dir (`CONFIG_DIR_NAME`). A project-scoped DB could live at `path.join(ctx.cwd, ".pi", "memory.db")` — but gate any project-local persistence behind `ctx.isProjectTrusted()`, and prefer one global DB keyed by a `project` column (use `ctx.cwd` as key) to avoid polluting repos.
- **Session-scoped state** (not suitable for a cross-session memory DB, but useful for flags): `pi.appendEntry(customType, data)` persists in the session JSONL (never sent to the LLM); reconstruct on `session_start` by scanning `ctx.sessionManager.getEntries()`.
- Sessions live in `~/.pi/agent/sessions/<escaped-cwd>/*.jsonl` (observed locally; `getSessionsDir()` = `join(getAgentDir(), "sessions")`).

---

## 9. SQLite runtime — CONFIRMED working

This install runs extensions under **Node v24.4.0** (pi's `dist/cli.js` has `#!/usr/bin/env node`). Verified locally:

- `require('node:sqlite')` → exports `DatabaseSync`, `StatementSync`, `constants`, `backup` (with an `ExperimentalWarning: SQLite is an experimental feature` — harmless; suppress with `process.env.NODE_NO_WARNINGS` if it pollutes TUI; better, it goes to stderr and pi's TUI is unaffected).
- **FTS5 is compiled in**: `CREATE VIRTUAL TABLE mem USING fts5(content)` + `MATCH` + `bm25()` all tested and working under this exact Node binary.

So **`node:sqlite` is the right choice** — no native deps, no better-sqlite3 build step. (`bun:sqlite` would only apply when running pi's compiled Bun binary distribution, which this is not.) Note `DatabaseSync` is fully synchronous; open in the factory or `session_start`, close in `session_shutdown`.

Caveat (uncertain): if the user ever switches to the Bun-binary distribution of pi, `node:sqlite` is unavailable there; a runtime check `process.versions.bun` with a `bun:sqlite` fallback would make the extension portable. Not required for this machine.

---

## 10. UI affordances (brief; confirmed from ExtensionUIContext)

```typescript
ctx.ui.notify(message, "info" | "warning" | "error");          // non-blocking toast
ctx.ui.setStatus("memory", "12 memories");                      // footer status (undefined to clear)
ctx.ui.setWidget("memory", ["line1", "line2"]);                 // widget above editor
await ctx.ui.confirm(title, message, { timeout?: ms });         // boolean
await ctx.ui.select(title, options);                            // string | undefined
await ctx.ui.input(title, placeholder?);                        // string | undefined
ctx.ui.setWorkingMessage("Recalling memories...");
```

Guard with `ctx.hasUI` (false in `-p` print and json modes); guard TUI-only features (`ctx.ui.custom()`, widgets-as-components) with `ctx.mode === "tui"`.

Error handling: extension errors are logged and the agent continues; `tool_call` handler errors block the tool (fail-safe).

---

## 11. Complete example: skeleton memory extension (synthesized from confirmed APIs)

Everything below uses only APIs verified in the local v0.79.1 types/examples; FTS5 calls verified against this Node binary.

```typescript
// ~/.pi/agent/extensions/memory.ts
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Type } from "typebox";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function memoryExtension(pi: ExtensionAPI) {
  const dbDir = path.join(getAgentDir(), "memory");
  fs.mkdirSync(dbDir, { recursive: true });
  const db = new DatabaseSync(path.join(dbDir, "memory.db"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY,
      project TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'fact',
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      text, content='memories', content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, text) VALUES (new.id, new.text);
    END;
  `);

  // (a) INJECT relevant memories into the system prompt each turn
  pi.on("before_agent_start", async (event, ctx) => {
    const rows = db.prepare(
      `SELECT m.text FROM memories_fts f JOIN memories m ON m.id = f.rowid
       WHERE memories_fts MATCH ? AND m.project = ? ORDER BY bm25(memories_fts) LIMIT 10`
    ).all(ftsQueryFrom(event.prompt), ctx.cwd) as { text: string }[];
    if (rows.length === 0) return;
    return {
      systemPrompt: event.systemPrompt +
        "\n\n## Memories\nFacts remembered from previous sessions:\n" +
        rows.map((r) => `- ${r.text}`).join("\n"),
    };
  });

  // (b) OBSERVE the conversation to extract memories
  pi.on("message_end", async (event, ctx) => {
    const m = event.message;
    if (m.role === "user" && typeof m.content === "string") {
      // analyze user text...
    } else if (m.role === "assistant") {
      const text = m.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
      // analyze assistant text...
    }
  });

  // (c) LLM-callable tools
  pi.registerTool({
    name: "memory_save",
    label: "Save Memory",
    description: "Persist a durable fact, preference, or decision for future sessions.",
    promptSnippet: "Save a durable fact to long-term memory",
    promptGuidelines: ["Use memory_save when the user states a lasting preference, decision, or project fact."],
    parameters: Type.Object({
      text: Type.String({ description: "The memory text, one self-contained fact" }),
      kind: Type.Optional(Type.String({ description: "fact | preference | decision" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      db.prepare("INSERT INTO memories (project, kind, text, created_at) VALUES (?, ?, ?, ?)")
        .run(ctx.cwd, params.kind ?? "fact", params.text, Date.now());
      return { content: [{ type: "text", text: `Saved memory: ${params.text}` }], details: {} };
    },
  });

  pi.registerTool({
    name: "memory_search",
    label: "Search Memory",
    description: "Full-text search over long-term memories for this project.",
    promptSnippet: "Search long-term memory (FTS5)",
    parameters: Type.Object({ query: Type.String() }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const rows = db.prepare(
        `SELECT m.id, m.text FROM memories_fts f JOIN memories m ON m.id = f.rowid
         WHERE memories_fts MATCH ? AND m.project = ? ORDER BY bm25(memories_fts) LIMIT 20`
      ).all(ftsQueryFrom(params.query), ctx.cwd) as { id: number; text: string }[];
      const text = rows.length ? rows.map((r) => `[${r.id}] ${r.text}`).join("\n") : "No memories found.";
      return { content: [{ type: "text", text }], details: { count: rows.length } };
    },
  });

  // (d) slash command + status
  pi.registerCommand("memories", {
    description: "Show memory count for this project",
    handler: async (_args, ctx) => {
      const { n } = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE project = ?").get(ctx.cwd) as { n: number };
      ctx.ui.notify(`${n} memories stored`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus("memory", "mem ✓");
  });

  // (e) cleanup — runtime is torn down on quit/reload/new/resume/fork
  pi.on("session_shutdown", async () => { db.close(); });
}

/** Escape user text into a safe FTS5 query (quote each token). */
function ftsQueryFrom(text: string): string {
  const tokens = text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
  if (tokens.length === 0) return '""';
  return tokens.slice(0, 12).map((t) => `"${t}"`).join(" OR ");
}
```

---

## 12. Gotchas checklist

1. **Package names**: import from `@earendil-works/pi-coding-agent` (NOT `@mariozechner/pi`). TypeBox via `import { Type } from "typebox"` (or from `@earendil-works/pi-ai`).
2. **Runtime teardown**: every `/new`, `/resume`, `/fork`, `/reload` reloads extensions. Close DB in `session_shutdown`, reopen in factory (factory reruns on reload). After replacement, captured old `pi`/`ctx` objects throw (`assertActive`).
3. **before_agent_start chaining**: always build on `event.systemPrompt` (it includes earlier extensions' changes); return `systemPrompt`, don't assign.
4. **FTS5 MATCH syntax errors throw** — sanitize/quote user text before `MATCH` (see `ftsQueryFrom` above).
5. **Parallel tools**: default execution is parallel; `DatabaseSync` is synchronous so individual statements are atomic, but set `executionMode: "sequential"` on tools if cross-statement ordering matters.
6. **Truncate** tool output ≤ 50KB / 2000 lines (`truncateHead`/`truncateTail`).
7. **Throw to fail** a tool; returning never sets `isError`.
8. `node:sqlite` emits an ExperimentalWarning on stderr in Node 24 — cosmetic only.
9. `StringEnum` (from `@earendil-works/pi-ai`) for enum params, not `Type.Union` of literals.
10. Dev typing: `npm i -D @earendil-works/pi-coding-agent typebox` in the extension's package dir gives editor types; at runtime pi aliases its own copies, so version-match with the installed pi (0.79.1) to avoid type drift.
11. For testing: `pi -e ./memory.ts -p "say hi"` runs print mode with the extension; `pi --no-extensions -e ./memory.ts` isolates it.
12. `message_end` fires for toolResult messages too — filter by `role` or you'll index tool output as "conversation".

## Source-of-truth file paths

- Extension types: `<pkg>/dist/core/extensions/types.d.ts`
- Loader/discovery: `<pkg>/dist/core/extensions/loader.js`
- Config paths: `<pkg>/dist/config.js` (`getAgentDir`, `CONFIG_DIR_NAME`, `ENV_AGENT_DIR`)
- Message types: `<pkg>/node_modules/@earendil-works/pi-ai/dist/types.d.ts`, `<pkg>/dist/core/messages.d.ts`
- Session types: `<pkg>/dist/core/session-manager.d.ts`
- Docs: `<pkg>/docs/extensions.md` (2656 lines), `docs/packages.md`, `docs/settings.md`
- Examples: `<pkg>/examples/extensions/` — most relevant: `hello.ts`, `claude-rules.ts` (system-prompt injection from files), `pirate.ts` (toggleable prompt injection), `todo.ts` (stateful tool), `with-deps/` (npm deps), `plan-mode/` (large multi-feature extension)
