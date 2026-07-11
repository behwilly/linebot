require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const client = new line.Client(config);
const app = express();

// 🌟 新增：機器人的短暫記憶體 (用來記住大家的 ID 和名字)
const userCache = new Map();

// 給 cron-job 敲門用的喚醒路由
app.get('/', (req, res) => {
  res.send('OK');
});

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
  // 🌟 隱藏功能：有人發言時，默默記住他的名字
  // ==========================================
  if (event.type === 'message' && event.source.type === 'group') {
    const userId = event.source.userId;
    const groupId = event.source.groupId;
    
    // 如果記憶體裡還沒有這個人，就去查名字並記下來
    if (!userCache.has(userId)) {
      client.getGroupMemberProfile(groupId, userId)
        .then(profile => {
          userCache.set(userId, profile.displayName);
        })
        .catch(() => {
          // 查不到就算了，不影響運作
        });
    }
  }

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
        
        // 🌟 新成員加入時，立刻寫入記憶體
        userCache.set(joinedUserId, userName);
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
  // 功能 B：有人離開或被踢出群組時的提示
  // ==========================================
  if (event.type === 'memberLeft') {
    if (event.source.type === 'group') {
      const groupId = event.source.groupId;
      const leftMembers = event.left.members;

      try {
        for (let member of leftMembers) {
          // 🌟 核心改變：不去問 LINE 伺服器了，直接翻找自己的記憶體
          // 如果記憶體有存，就用記憶體的名字；如果沒有，才顯示「一位成員」
          const userName = userCache.get(member.userId) || '一位成員';

          const leaveMessage = {
            type: 'text',
            text: `👋 ${userName} 離開了群組。`
          };

          await client.pushMessage(groupId, leaveMessage);
          
          // 人離開了，順便把他在記憶體裡的資料刪除，節省空間
          userCache.delete(member.userId);
        }
      } catch (error) {
        console.error('發送離開訊息失敗:', error);
      }
    }
    return Promise.resolve(null);
  }

  return Promise.resolve(null);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🤖 機器人伺服器已啟動，正在監聽通訊埠：${PORT}`);
});
