require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');

// 1. 設定 LINE 憑證
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

// 🌟 2. 取得「多個」管理員 ID (將 Render 上用逗號隔開的字串，轉換成名單陣列)
// 如果沒有設定，就預設給一個空陣列避免報錯
const ADMIN_USER_IDS = process.env.ADMIN_USER_IDS ? process.env.ADMIN_USER_IDS.split(',') : [];

const client = new line.Client(config);
const app = express();

app.post('/webhook', line.middleware(config), (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error('Webhook 發生錯誤:', err);
      res.status(500).end();
    });
});

async function handleEvent(event) {
  
  // ==========================================
  // 功能 A：自動 @標記真實名字 並發送群規
  // ==========================================
  if (event.type === 'memberJoined') {
    const joinedUserId = event.joined.members[0].userId;
    let userName = '新成員';

    try {
      if (event.source.type === 'group') {
        const profile = await client.getGroupMemberProfile(event.source.groupId, joinedUserId);
        userName = profile.displayName; 
      }
    } catch (error) {
      console.log('無法抓取新成員名稱');
    }
    
    const ruleText = `買賣群新規定
1:進買賣群需要通過版主及管理員，不得擅自邀請及踢人

2:物件、返豆、現刷凡是交易，請勿PO出價錢（價錢不公開）若要便宜出，可打上：甜價或者豬肉價

3:為保障大家帳戶安全，代售著也需要負起連帶責任，介紹的請注意。

4:為妥善管理人員記事本留言處需簽到，管理員會審核，所以不要亂放！

5.若惡意棄單，遭人提供截圖檢舉，確認屬實，進行踢出！所以下單時請先想好再購買！

6:如代客收物件返豆，客人無法立即匯款，一律收取訂金視同交易成功，客人若反悔或已經有收到（訂金不退款）契約精神

7:非重大事件情節請勿欸特所有人，尤其是半夜

創新群，一切照規定走！
若犯不會寬待，請大家配合🙏🏻`;

    const mentionText = `@${userName}`;
    const replyText = `${mentionText}\n\n${ruleText}`;

    const welcomeMessage = {
      type: 'text',
      text: replyText,
      mentions: {
        mentionees: [{
            index: 0,
            length: mentionText.length,
            type: 'user',
            userId: joinedUserId
        }]
      }
    };

    return client.replyMessage(event.replyToken, welcomeMessage);
  }

  // ==========================================
  // 功能 B & C：接收文字訊息處理
  // ==========================================
  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text.trim().toLowerCase();
    const senderId = event.source.userId; // 發言人的 ID

    // 🌟 功能 C：隱藏指令，讓其他管理員查詢自己的 ID
    // 只要有人打 "!我的id" 或 "！我的id" (全形半形都可以)，機器人就會回報他的 ID
    if (text === '!我的id' || text === '！我的id') {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `你的專屬 User ID 是：\n${senderId}\n\n請將這串代碼交給總管理員設定權限。`
      });
    }

    // 🌟 功能 B：管理員專屬指令 - 標記踢人 (ban @某人)
    if (text.startsWith('ban') && event.message.mentions && event.message.mentions.mentionees.length > 0) {
      
      // 🚨 安全檢查 1：使用 includes() 檢查發言人是否在管理員名單中
      if (!ADMIN_USER_IDS.includes(senderId)) {
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: '❌ 警告：你不在管理員名單中，沒有權限使用此指令。'
        });
      }

      // 🚨 安全檢查 2：確保是在群組內執行
      if (event.source.type !== 'group') {
        return Promise.resolve(null);
      }

      const groupId = event.source.groupId;
      const targets = event.message.mentions.mentionees;

      try {
        for (let target of targets) {
          if (target.type === 'user') {
            await client.kickGroupMember(groupId, target.userId);
          }
        }
        
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: '✅ 已依管理員指令，將違規成員請出群組。'
        });

      } catch (error) {
        console.error('踢人失敗:', error);
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: '❌ 踢除失敗。請確認機器人是否被設定為可以踢人，或者對方是否已經離開群組。'
        });
      }
    }
  }

  return Promise.resolve(null);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🤖 機器人伺服器已啟動，正在監聽通訊埠：${PORT}`);
});
