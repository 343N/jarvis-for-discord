import "dotenv/config";
import { readFileSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import Anthropic from "@anthropic-ai/sdk";
import { Resvg } from "@resvg/resvg-js";
import {
  ActivityType,
  AttachmentBuilder,
  Client,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment

// The only models /model can switch to. Fable is intentionally left out.
const PRESET_MODELS = [
  { alias: "opus", name: "Claude Opus 5.5", id: "claude-opus-5-5" },
  { alias: "sonnet", name: "Claude Sonnet 5.5", id: "claude-sonnet-5-5" },
  { alias: "haiku", name: "Claude Haiku 5.5", id: "claude-haiku-5-5" },
  { alias: "opus-5", name: "Claude Opus 5", id: "claude-opus-5" },
  { alias: "sonnet-5", name: "Claude Sonnet 5", id: "claude-sonnet-5" },
  { alias: "haiku-4.5", name: "Claude Haiku 4.5", id: "claude-haiku-4-5" },
];

// Models that accept server-side refusal fallbacks (`fallbacks: "default"`).
const FALLBACK_MODELS = new Set([
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5-5",
]);

const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ??
  "You are Jarvis, chatting as a person in a Discord server. Keep replies concise and conversational. You MUST match the energy of the message you're receiving." +
  "Each user message is prefixed with the sender's display name. " +
  "Discord markdown is supported; keep replies under ~1500 characters unless asked for more. ";

const SCAN_LIMIT = 100; // how many recent channel messages to look through (Discord's max per fetch)
const MAX_HISTORY = 30; // how many bot-related messages from those to send as history
const DISCORD_LIMIT = 2000;
const LOG_DIR = "logs";
const WIPES_FILE = "wipes.json";
const MODEL_FILE = "model.json";

const MAX_TOOL_ROUNDS = 5; // how many times Claude may call tools before it must answer
const MAX_DIAGRAMS = 4; // diagrams per reply
const MAX_SVG_CHARS = 200_000;
const DIAGRAM_SIZE = 1600; // longest side of the rendered PNG, in pixels

const DIAGRAM_TOOL = {
  name: "send_diagram",
  description:
    "Render an SVG image to PNG and attach it to your Discord reply. Use it when a visual " +
    "(flowchart, diagram, chart, layout, simple illustration) would explain something better than " +
    "text, or when someone asks for a picture or diagram. Write a complete standalone SVG with a " +
    "viewBox or width/height. Use only inline shapes, paths and text: external images, links, " +
    "web fonts and CSS imports are blocked. Use a light background and readable font sizes. " +
    "The image is attached to your reply automatically, so refer to it in your text and never paste the SVG source. " +
    "In the conversation history, <image_sent> marks each image you attached to an earlier reply. " +
    "It's added automatically, so never write it yourself.",
  input_schema: {
    type: "object",
    properties: {
      svg: { type: "string", description: "The full SVG document, starting with <svg" },
      title: { type: "string", description: "A short title, used as the image's filename" },
    },
    required: ["svg", "title"],
    additionalProperties: false,
  },
};

const IMAGE_MARKER = "<image_sent>"; // added to history for each image the bot attached

// Blocks anything that could make the renderer load a file or URL: only #fragment and inline data: images are allowed.
const EXTERNAL_REF = /href\s*=\s*["']\s*(?!#|data:image\/)|url\(\s*["']?\s*(?!#)|@import/i;

// Server IDs the bot may respond in. Empty (ALLOWED_SERVERS unset) means every server is allowed.
const ALLOWED_SERVERS = new Set(
  (process.env.ALLOWED_SERVERS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
);

function isServerAllowed(guildId) {
  return ALLOWED_SERVERS.size === 0 || ALLOWED_SERVERS.has(guildId);
}

// Look up a preset by alias or model id; anything else (including Fable) returns undefined.
function findPreset(name) {
  const key = name?.trim().toLowerCase();
  return PRESET_MODELS.find((p) => p.alias === key || p.id === key);
}

const defaultModel = findPreset(process.env.DEFAULT_MODEL) ?? PRESET_MODELS[0];
if (process.env.DEFAULT_MODEL && !findPreset(process.env.DEFAULT_MODEL)) {
  console.warn(`DEFAULT_MODEL "${process.env.DEFAULT_MODEL}" isn't an allowed preset; using ${defaultModel.id}.`);
}
// Start on the model chosen before the last restart, if it's still an allowed preset.
let currentModel = findPreset(loadSavedModel()) ?? defaultModel;

function loadSavedModel() {
  try {
    return JSON.parse(readFileSync(MODEL_FILE, "utf8")).model;
  } catch {
    return undefined; // never switched (or unreadable file)
  }
}

async function setCurrentModel(preset) {
  currentModel = preset;
  setModelStatus(preset.id);
  await writeFile(MODEL_FILE, JSON.stringify({ model: preset.id }, null, 2), "utf8");
}

// Channel ID → timestamp of the last /wipe. Messages older than that are left out of history.
const wipes = new Map(Object.entries(loadWipes()));

function loadWipes() {
  try {
    return JSON.parse(readFileSync(WIPES_FILE, "utf8"));
  } catch {
    return {}; // no wipes yet (or unreadable file)
  }
}

async function saveWipes() {
  await writeFile(WIPES_FILE, JSON.stringify(Object.fromEntries(wipes), null, 2), "utf8");
}

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  presence: { status: "online" },
});

const modelCommand = new SlashCommandBuilder()
  .setName("model")
  .setDescription("Show or change the Claude model the bot uses")
  .addStringOption((option) =>
    option
      .setName("model")
      .setDescription("The model to switch to (leave empty to see the current one)")
      .addChoices(PRESET_MODELS.map((p) => ({ name: `${p.name} (${p.id})`, value: p.id }))),
  );

const wipeCommand = new SlashCommandBuilder()
  .setName("wipe")
  .setDescription("Make the bot forget its conversation history in this channel");

const resetModelCommand = new SlashCommandBuilder()
  .setName("resetmodel") // Discord requires lowercase command names
  .setDescription("Reset the model back to the default");

const commandHandlers = {
  model: handleModelCommand,
  wipe: handleWipeCommand,
  resetmodel: handleResetModelCommand,
};

discord.once("clientReady", async (c) => {
  await c.application.commands.set([modelCommand, wipeCommand, resetModelCommand].map((cmd) => cmd.toJSON()));
  setModelStatus(currentModel.id);
  console.log(`Logged in as ${c.user.tag} — using ${currentModel.id}`);
});

let statusModelId; // the model shown in the bot's profile status

// Show a model in the bot's custom status. Skips the update when it's already shown.
function setModelStatus(modelId) {
  if (!modelId || modelId === statusModelId) return;
  statusModelId = modelId;
  const name = findPreset(modelId)?.name ?? modelId; // fallback models may not be presets
  discord.user.setPresence({
    status: "online",
    activities: [{ type: ActivityType.Custom, name: "custom", state: `Running on ${name}` }],
  });
}

// The model that produced a response: after a refusal fallback, that's the last fallback block's target.
function respondingModel(response) {
  const fallback = response.content.findLast((block) => block.type === "fallback");
  return fallback?.to.model ?? response.model;
}

discord.on("messageCreate", async (message) => {
  if (message.author.bot || !message.inGuild() || !isServerAllowed(message.guildId)) return;
  if (!isAddressedToBot(message)) return;

  let reply;
  try {
    reply = await respond(message);
  } catch (err) {
    console.error(err);
    reply = `Something went wrong: ${describeError(err)}`;
    await message.reply(reply).catch(() => {});
  }
  await logExchange(message, reply);
});

// Append the request and the bot's reply to logs/YYYY-MM-DD.log (local date).
async function logExchange(message, reply) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  const entry = [
    `[${date} ${time}]`,
    `Server:   ${message.guild.name} (${message.guild.id})`,
    `Channel:  #${message.channel.name} (${message.channel.id})`,
    `User:     ${message.author.username} (${message.author.id})`,
    `Model:    ${currentModel.id}`,
    `Request:  ${message.cleanContent}`,
    `Response: ${reply ?? "(no reply)"}`,
    "-".repeat(60),
    "",
  ].join("\n");

  try {
    await mkdir(LOG_DIR, { recursive: true });
    await appendFile(path.join(LOG_DIR, `${date}.log`), entry, "utf8");
  } catch (err) {
    console.error("Failed to write log:", err);
  }
}

discord.on("interactionCreate", async (interaction) => {
  const handler = interaction.isChatInputCommand() && commandHandlers[interaction.commandName];
  if (!handler) return;

  if (!isServerAllowed(interaction.guildId)) {
    await interaction
      .reply({ content: "This bot isn't allowed in this server.", flags: MessageFlags.Ephemeral })
      .catch(() => {});
    return;
  }

  try {
    await handler(interaction);
  } catch (err) {
    console.error(err);
    await interaction
      .reply({ content: `Something went wrong: ${describeError(err)}`, flags: MessageFlags.Ephemeral })
      .catch(() => {});
  }
});

async function handleModelCommand(interaction) {
  const arg = interaction.options.getString("model");

  if (!arg) {
    await interaction.reply({
      content: `Current model: **${currentModel.name}** (\`${currentModel.id}\`)`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!(await requireManageGuild(interaction, "change the model"))) return;

  // Discord only offers the preset choices, but check anyway in case a stale command sends something else.
  const preset = findPreset(arg);
  if (!preset) {
    await interaction.reply({ content: `\`${arg}\` isn't an allowed model.`, flags: MessageFlags.Ephemeral });
    return;
  }

  await setCurrentModel(preset);
  await interaction.reply(`Model set to **${preset.name}** (\`${preset.id}\`).`);
}

async function handleWipeCommand(interaction) {
  if (!(await requireManageGuild(interaction, "wipe the bot's history"))) return;

  wipes.set(interaction.channelId, Date.now());
  await saveWipes();
  await interaction.reply("History wiped — I won't remember anything said in this channel before now.");
}

async function handleResetModelCommand(interaction) {
  if (!(await requireManageGuild(interaction, "reset the model"))) return;

  await setCurrentModel(defaultModel);
  await interaction.reply(`Model reset to the default: **${defaultModel.name}** (\`${defaultModel.id}\`).`);
}

// Replies with an error and returns false if the user lacks Manage Server.
async function requireManageGuild(interaction, action) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  await interaction.reply({
    content: `You need the Manage Server permission to ${action}.`,
    flags: MessageFlags.Ephemeral,
  });
  return false;
}

// A message mentions the bot or replies to one of its messages.
function isAddressedToBot(message) {
  return (
    message.mentions.users.has(discord.user.id) ||
    message.mentions.repliedUser?.id === discord.user.id
  );
}

// A message is part of the bot's conversation: the bot's own chat replies, or messages addressed to it.
function involvesBot(message) {
  if (message.author.id === discord.user.id) return !message.interactionMetadata; // skip slash command replies
  return !message.author.bot && isAddressedToBot(message);
}

// Build history from recent channel messages that involve the bot, ignoring everything else.
async function buildHistory(message) {
  const recent = await message.channel.messages.fetch({ limit: SCAN_LIMIT, before: message.id });
  const wipedAt = wipes.get(message.channelId) ?? 0;
  const related = [...recent.values()]
    .filter((msg) => msg.createdTimestamp > wipedAt && involvesBot(msg))
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .slice(-MAX_HISTORY);
  related.push(message);

  const messages = [];
  for (const msg of related) {
    const isBot = msg.author.id === discord.user.id;
    let text = stripMention(msg.content);
    // Mark images the bot sent so Claude knows it attached them (they aren't part of the text).
    if (isBot && msg.attachments.size) {
      text = [text, ...Array(msg.attachments.size).fill(IMAGE_MARKER)].filter(Boolean).join("\n");
    }
    if (!text) continue;
    messages.push(
      isBot
        ? { role: "assistant", content: text }
        : { role: "user", content: `${msg.member?.displayName ?? msg.author.username}: ${text}` },
    );
  }

  // The API requires the conversation to start with a user turn.
  while (messages.length && messages[0].role === "assistant") messages.shift();
  return messages;
}

function stripMention(content) {
  return content.replace(new RegExp(`<@!?${discord.user.id}>`, "g"), "").trim();
}

async function respond(message) {
  const messages = await buildHistory(message);
  if (!messages.length) return;

  await message.channel.sendTyping();
  const typing = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000);

  try {
    const diagrams = []; // { title, file } rendered during this reply
    let response;

    // Let Claude call send_diagram as needed, then answer.
    for (let round = 0; ; round++) {
      response = await createMessage(messages);
      if (response.stop_reason !== "tool_use" || round >= MAX_TOOL_ROUNDS) break;

      messages.push({ role: "assistant", content: echoableContent(response.content) });
      const toolResults = response.content
        .filter((block) => block.type === "tool_use")
        .map((block) => runTool(block, diagrams));
      messages.push({ role: "user", content: toolResults });
    }

    setModelStatus(respondingModel(response));

    if (response.stop_reason === "refusal") {
      const refusal = "Sorry, I can't help with that one.";
      await message.reply(refusal);
      return refusal;
    }

    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .replaceAll(IMAGE_MARKER, "") // in case Claude copies the history marker
      .trim();
    const files = diagrams.map((d) => d.file);

    // Send the text in Discord-sized chunks, with any diagrams on the last one.
    const chunks = text ? splitMessage(text) : files.length ? [""] : ["(no response)"];
    let last = message;
    for (const [i, chunk] of chunks.entries()) {
      last = await last.reply({
        content: chunk || undefined,
        files: i === chunks.length - 1 ? files : [],
        allowedMentions: { repliedUser: false },
      });
    }

    const attached = diagrams.map((d) => `[diagram: ${d.title}]`).join(" ");
    return [text, attached].filter(Boolean).join("\n") || "(no response)";
  } finally {
    clearInterval(typing);
  }
}

async function createMessage(messages) {
  const params = {
    model: currentModel.id,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    tools: [DIAGRAM_TOOL],
    messages,
  };

  // On supported models, let the API retry a refused request on a fallback model.
  return FALLBACK_MODELS.has(currentModel.id)
    ? anthropic.beta.messages.create({
        ...params,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      })
    : anthropic.messages.create(params);
}

// After a fallback switch, only text from before the switch may be sent back to the API.
function echoableContent(content) {
  const boundary = content.findLastIndex((block) => block.type === "fallback");
  if (boundary < 0) return content;
  return content.filter((block, i) => i > boundary || block.type === "text");
}

// Run one tool call and return its tool_result block. Rendered diagrams are pushed onto `diagrams`.
function runTool(block, diagrams) {
  const result = (content, isError = false) => ({
    type: "tool_result",
    tool_use_id: block.id,
    content,
    ...(isError && { is_error: true }),
  });

  if (block.name !== DIAGRAM_TOOL.name) return result(`Unknown tool: ${block.name}`, true);
  if (diagrams.length >= MAX_DIAGRAMS) {
    return result(`Limit of ${MAX_DIAGRAMS} diagrams per reply reached.`, true);
  }

  try {
    const { svg, title } = block.input ?? {};
    const png = renderSvg(svg);
    const name = `${slugify(title)}.png`;
    diagrams.push({ title: title || "diagram", file: new AttachmentBuilder(png, { name }) });
    return result(`Rendered "${title}" as ${name}. It will be attached to your reply.`);
  } catch (err) {
    return result(`Could not render the SVG: ${err.message}. Fix it and try again.`, true);
  }
}

function renderSvg(svg) {
  if (typeof svg !== "string" || !/<svg[\s>]/i.test(svg)) throw new Error("input is not an SVG document");
  if (svg.length > MAX_SVG_CHARS) throw new Error(`SVG is over ${MAX_SVG_CHARS} characters`);
  if (EXTERNAL_REF.test(svg)) throw new Error("external references (links, images, fonts, imports) aren't allowed");

  const options = { background: "white", font: { loadSystemFonts: true, defaultFontFamily: "Arial" } };
  // Measure first so the longest side is scaled to DIAGRAM_SIZE (keeps very tall or wide SVGs from exploding).
  const { width, height } = new Resvg(svg, options);
  if (!width || !height) throw new Error("the SVG has no size; add a viewBox or width/height");
  if (Math.max(width, height) / Math.min(width, height) > 10) {
    throw new Error("the SVG is too long and thin; keep the aspect ratio within 10:1");
  }
  const fitTo = width >= height ? { mode: "width", value: DIAGRAM_SIZE } : { mode: "height", value: DIAGRAM_SIZE };
  return new Resvg(svg, { ...options, fitTo }).render().asPng();
}

function slugify(title) {
  const slug = String(title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return slug || "diagram";
}

// Split text into Discord-sized pieces, preferring newline boundaries.
function splitMessage(text) {
  const chunks = [];
  while (text.length > DISCORD_LIMIT) {
    let cut = text.lastIndexOf("\n", DISCORD_LIMIT);
    if (cut < DISCORD_LIMIT / 2) cut = DISCORD_LIMIT;
    chunks.push(text.slice(0, cut));
    text = text.slice(cut).trimStart();
  }
  if (text) chunks.push(text);
  return chunks;
}

function describeError(err) {
  if (err instanceof Anthropic.RateLimitError) return "rate limited, try again shortly.";
  if (err instanceof Anthropic.AuthenticationError) return "invalid Anthropic API key.";
  if (err instanceof Anthropic.APIError) return `API error ${err.status}: ${err.message}`;
  return err.message ?? String(err);
}

// Go offline right away on shutdown instead of waiting for Discord to time the connection out.
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    if (discord.isReady()) {
      discord.user.setPresence({ status: "invisible", activities: [] });
      await sleep(500); // give the presence update time to reach the gateway before closing
    }
    await discord.destroy(); // a clean close also tells Discord the bot is gone
  } catch (err) {
    console.error("Error while shutting down:", err);
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// On Windows, pm2 can't send signals, so it sends this message instead (needs shutdown_with_message).
process.on("message", (msg) => msg === "shutdown" && shutdown());

discord.login(process.env.DISCORD_TOKEN);
