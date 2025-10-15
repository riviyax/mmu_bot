import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import P from "pino";
import axios from "axios";
import fs from "fs";
import path from "path";
import express from "express";
import QRCode from "qrcode";

const spamTracker = new Map();
const whitelist = new Set();
const app = express();
let currentQR = ""; // Will store the live QR code temporarily

app.get("/", (req, res) => {
  if (!currentQR) {
    return res.send("<h2>⏳ QR Code not available. Please wait...</h2>");
  }

  QRCode.toDataURL(currentQR, (err, url) => {
    if (err) return res.send("❌ Error generating QR code");

    res.send(`
      <h2>📲 Scan the QR Code with WhatsApp</h2>
      <img src="${url}" alt="WhatsApp QR Code" />
    `);
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🌐 QR Web Server running at: http://localhost:${PORT}`)
);

async function startBot() {
  try {
    console.log("🚀 Starting bot...");

    const { state, saveCreds } = await useMultiFileAuthState("./session");
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger: P({ level: "silent" }),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, P({ level: "silent" })),
      },
      browser: ["MMU Marks Bot", "Chrome", "1.0.0"],
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const qrcode = (await import("qrcode-terminal")).default;
        qrcode.generate(qr, { small: true });
        currentQR = qr; // Save to serve in web
        console.log("📲 QR available at: http://localhost:3000");
      }

      if (connection === "open") {
        console.log("✅ WhatsApp connected!");
        currentQR = ""; // Clear QR after connection
      } else if (connection === "close") {
        const reason =
          lastDisconnect?.error?.output?.statusCode ||
          lastDisconnect?.error?.message;
        console.error("⚠️ Connection closed:", reason);
        if (reason !== DisconnectReason.loggedOut) startBot();
        else
          console.log("❌ Logged out. Delete ./session folder and restart.");
      }
    });

    const sendImageWithCaption = async (jid, caption) => {
      const imagePath = path.resolve("./images/main.png");
      if (!fs.existsSync(imagePath)) {
        await sock.sendMessage(jid, { text: caption });
        return;
      }
      await sock.sendMessage(jid, {
        image: { url: imagePath },
        caption,
      });
    };

    const checkSpam = async (jid, command) => {
      const now = Date.now();
      const userData = spamTracker.get(jid) || {};
      const timestamps = userData[command] || [];
      const recent = timestamps.filter((t) => now - t < 60000);
      recent.push(now);
      userData[command] = recent;
      spamTracker.set(jid, userData);

      if (!whitelist.has(jid) && recent.length >= 4) {
        await sock.sendMessage(jid, {
          text: "⚠️ You are sending too many commands. Temporarily blocked.",
        });
        console.log(`🚫 ${jid} blocked for spam`);
        return true;
      }

      if (whitelist.has(jid) && recent.length >= 4) {
        await sock.sendMessage(jid, {
          text: "⚠️ You are sending the same command repeatedly. Please avoid spamming.",
        });
        return false;
      }

      return false;
    };

    const getMembers = async () => {
      try {
        const res = await axios.get("https://marks.vercel.app/api/members");
        if (!Array.isArray(res.data)) return [];
        return res.data.map((m) => ({
          name: m.name?.trim() || "Unknown",
          rank: m.rank?.trim() || "Unknown",
          marks: m.marks ?? "0",
        }));
      } catch (err) {
        console.error("❌ Error fetching members:", err.message);
        return [];
      }
    };

    sock.ev.on("messages.upsert", async (m) => {
      try {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const body =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          "";

        if (!body.startsWith("!")) return;

        const args = body.trim().split(" ");
        const command = args[0].toLowerCase();

        if (await checkSpam(sender, command)) return;

        if (command === "!wishlist") {
          const action = args[1]?.toLowerCase();
          if (action === "remove") {
            if (whitelist.has(sender)) {
              whitelist.delete(sender);
              await sendImageWithCaption(
                sender,
                "✅ Removed from wishlist. Spam enabled."
              );
            } else {
              await sendImageWithCaption(
                sender,
                "⚠️ You are not in the wishlist."
              );
            }
          } else {
            if (!whitelist.has(sender)) {
              whitelist.add(sender);
              await sendImageWithCaption(
                sender,
                "✅ Added to wishlist. Spam disabled."
              );
            } else {
              await sendImageWithCaption(
                sender,
                "⚠️ You are already in the wishlist."
              );
            }
          }
          return;
        }

        if (command === "!rules") {
          const lang = args[1]?.toLowerCase() || "english";
          const rules =
            lang === "sinhala"
              ? `📜 *MMU Marks Bot Rules (සිංහල)*\n1️⃣ Spam නොකරන්න.\n2️⃣ විධාන නිවැරදිව භාවිතා කරන්න.\n3️⃣ Misuse වළකින්න.`
              : `📜 *MMU Marks Bot Rules (English)*\n1️⃣ Do not spam commands.\n2️⃣ Use commands properly.\n3️⃣ Misuse may result in block.`;
          await sendImageWithCaption(sender, rules);
          return;
        }

        if (command === "!markslist") {
          const members = await getMembers();
          if (members.length === 0) {
            await sendImageWithCaption(sender, "⚠️ No member data found.");
            return;
          }
          const listText = members
            .map(
              (m, i) =>
                `*${i + 1}. ${m.name}*\n│ *Rank:* ${m.rank}\n│ *Marks:* ${
                  m.marks
                }\n╰──────────────────────`
            )
            .join("\n");
          const message = `╭───────────────📘───────────────╮
│ 📋 *Members Marks List* │
├───────────────────────────────┤
${listText}
╰───────────────📘───────────────╯`;
          await sendImageWithCaption(sender, message);
          return;
        }

        if (command === "!marks") {
          if (!sender.endsWith("@s.whatsapp.net")) {
            await sendImageWithCaption(
              sender,
              "❌ This command works in private chat only."
            );
            return;
          }
          const name = args.slice(1).join(" ").trim().toLowerCase();
          if (!name) {
            await sendImageWithCaption(
              sender,
              "⚠️ Please provide a name. Example: !marks John Doe"
            );
            return;
          }
          const members = await getMembers();
          const found = members.find((m) =>
            m.name.toLowerCase().includes(name)
          );
          if (!found) {
            const suggestions = members
              .filter((m) => m.name.toLowerCase().includes(name.slice(0, 3)))
              .map((m) => m.name)
              .join(", ");
            await sendImageWithCaption(
              sender,
              suggestions
                ? `❌ No exact match found for *${name}*.\n💡 Maybe you meant: ${suggestions}`
                : `❌ No member found with name *${name}*.`
            );
            return;
          }
          let emoji = "🎓";
          if (found.rank.toLowerCase().includes("president")) emoji = "👑";
          else if (found.rank.toLowerCase().includes("secretary")) emoji = "📘";
          else if (found.rank.toLowerCase().includes("vice")) emoji = "⭐";

          const details = `╭───────────────📖───────────────╮
│ *${found.name}'s Details* │
├───────────────────────────────┤
│ ${emoji} *Rank:* ${found.rank}
│ 📊 *Marks:* ${found.marks}
╰───────────────────────────────╯`;
          await sendImageWithCaption(sender, details);
          return;
        }

        if (["!help", "!about", "!commands"].includes(command)) {
          const helpText = `╭───────────────🤖───────────────╮
│ *MMU Marks Bot* │
├───────────────────────────────┤
│ 💡 Commands: │
│ 🧾 !markslist → All members │
│ 🔍 !marks <name> → Member details │
│ 📜 !rules english/sinhala → Rules │
│ 💫 !wishlist / !wishlist remove → Toggle spam whitelist │
│ 🧠 Powered by Baileys + Axios │
╰───────────────────────────────╯`;
          await sendImageWithCaption(sender, helpText);
          return;
        }
      } catch (err) {
        console.error("❌ Message handler error:", err);
      }
    });
  } catch (err) {
    console.error("💥 Fatal bot error:", err);
  }
}

startBot();
