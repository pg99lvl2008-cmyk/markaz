/**
 * Telegram Voting Bot (Node.js + MongoDB)
 *
 * IMPORTANT:
 *  - DO NOT commit real credentials to public repos.
 *  - Replace BOT_TOKEN and MONGO_URI below with your real values BEFORE running.
 *
 * Usage:
 * 1) npm install
 * 2) node bot.js
 *
 * Notes:
 *  - Bot must be admin in the channel used for subscription checks.
 *  - Each user can vote only once; votes saved in MongoDB.
 */

const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');

// ----------------------
//  Replace the values below with your actual credentials:
// ----------------------
const BOT_TOKEN = '8304918790:AAEvUm4XK264kuZDclOZFS_c3JomN_7QbTg'; // e.g. 123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
const MONGO_URI = 'mongodb+srv://pg99lvl:Jasurbek%232008@cluster0.86xrt46.mongodb.net/votingdb?retryWrites=true&w=majority&appName=Cluster0'; // e.g. mongodb+srv://user:pass@cluster0.xxxxx.mongodb.net/votingdb?retryWrites=true&w=majority
const CHANNEL_USERNAME = '@behruz_academy'; // e.g. '@mychannel'
// ----------------------

// Basic sanity check
if (BOT_TOKEN.includes('REPLACE') || MONGO_URI.includes('REPLACE')) {
  console.error('ERROR: Please set BOT_TOKEN and MONGO_URI in bot.js before running.');
  process.exit(1);
}

// Connect to MongoDB
mongoose.connect(MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => {
  console.log('✅ Connected to MongoDB');
}).catch(err => {
  console.error('❌ MongoDB connection error:', err);
  process.exit(1);
});

// Define schema/model
const voteSchema = new mongoose.Schema({
  userId: { type: Number, unique: true, required: true },
  choice: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});
const Vote = mongoose.model('Vote', voteSchema);

// Create bot
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// List of choices (edit as needed)
const CHOICES = ['Matematika', 'Fizika', 'Ingliz tili'];

// /start command
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const name = msg.from.first_name || 'foydalanuvchi';
  const text = `Salom, ${name}!\nVotingda qatnashish uchun avval kanalga obuna bo'ling: ${CHANNEL_USERNAME}\n\nIltimos, obuna bo'lgach "✅ Obunani tekshirish" tugmasini bosing.`;

  const opts = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔔 Kanalga obuna bo‘lish', url: `https://t.me/${CHANNEL_USERNAME.replace('@','')}` }],
        [{ text: '✅ Obunani tekshirish', callback_data: 'check_subscription' }]
      ]
    }
  };

  bot.sendMessage(chatId, text, opts);
});

// Handle callback queries (subscription check & voting)
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;

  try {
    if (data === 'check_subscription') {
      // Check membership status in the channel
      try {
        const member = await bot.getChatMember(CHANNEL_USERNAME, userId);
        if (['member', 'creator', 'administrator'].includes(member.status)) {
          // Show voting menu
          await bot.answerCallbackQuery(query.id, { text: '✅ Obuna tasdiqlandi. Bot ichida ovoz berishingiz mumkin.' });
          await showVoting(chatId);
        } else {
          await bot.answerCallbackQuery(query.id, { text: '❌ Siz kanalga obuna emassiz.' });
          await bot.sendMessage(chatId, `Iltimos kanalga obuna bo'ling: ${CHANNEL_USERNAME}`);
        }
      } catch (err) {
        console.error('getChatMember error:', err);
        await bot.answerCallbackQuery(query.id, { text: '❌ Obunani tekshirishda xatolik. Bot kanalga adminmi yoki kanal username to\'g\'ri emas?' });
      }
      return;
    }

    if (data.startsWith('vote_')) {
      const choice = data.replace('vote_', '');
      if (!CHOICES.includes(choice)) {
        await bot.answerCallbackQuery(query.id, { text: 'Noto\'g\'ri tanlov.' });
        return;
      }

      // Ensure user is subscribed before accepting vote
      try {
        const member = await bot.getChatMember(CHANNEL_USERNAME, userId);
        if (!['member', 'creator', 'administrator'].includes(member.status)) {
          await bot.answerCallbackQuery(query.id, { text: '❌ Voting uchun avval kanalga obuna bo\'ling.' });
          return;
        }
      } catch (err) {
        console.error('getChatMember before vote error:', err);
        await bot.answerCallbackQuery(query.id, { text: '❌ Obunani tekshirishda xatolik.' });
        return;
      }

      // Check if user already voted
      const existing = await Vote.findOne({ userId });
      if (existing) {
        await bot.answerCallbackQuery(query.id, { text: '❌ Siz allaqachon ovoz bergansiz.' });
        return;
      }

      // Save vote
      await Vote.create({ userId, choice });
      await bot.answerCallbackQuery(query.id, { text: `✅ "${choice}" uchun ovoz qabul qilindi.` });

      // Send updated counts (optional: could be sent to admin chat instead)
      await sendVoteCounts(chatId);
      return;
    }
  } catch (err) {
    console.error('callback_query handler error:', err);
  }
});

// Show voting inline keyboard
async function showVoting(chatId) {
  const keyboard = CHOICES.map(choice => [{ text: choice, callback_data: `vote_${choice}` }]);
  const opts = { reply_markup: { inline_keyboard: keyboard } };
  await bot.sendMessage(chatId, 'Quyidagilardan birini tanlang:', opts);
}

// Aggregate and send vote counts
async function sendVoteCounts(chatId) {
  const results = await Vote.aggregate([
    { $group: { _id: '$choice', count: { $sum: 1 } } }
  ]);

  let text = '📊 Hozirgi natijalar:\n\n';
  CHOICES.forEach(c => {
    const row = results.find(r => r._id === c);
    const cnt = row ? row.count : 0;
    text += `${c}: ${cnt} ta ovoz\n`;
  });

  await bot.sendMessage(chatId, text);
}

// /results command - only allow the bot owner or channel admins to query results via private chat
bot.onText(/\/results/, async (msg) => {
  const chatId = msg.chat.id;
  const fromId = msg.from.id;

  try {
    // Try to see if user is an admin in the channel
    const member = await bot.getChatMember(CHANNEL_USERNAME, fromId);
    if (!['administrator', 'creator'].includes(member.status)) {
      // Not an admin: deny
      await bot.sendMessage(chatId, '❌ Bu komandani faqat kanal adminlari ishlatishi mumkin.');
      return;
    }
  } catch (err) {
    // If getChatMember fails (e.g., channel username wrong), fallback to deny
    console.error('/results check error:', err);
    await bot.sendMessage(chatId, '❌ Natijalarni olish uchun xatolik yuz berdi. Kanal va bot sozlamalarini tekshiring.');
    return;
  }

  // Send aggregated results
  await sendVoteCounts(chatId);
});

console.log('Bot ishga tushdi...');