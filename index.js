require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');

// 1. 設定 LINE 憑證 (對應 Render 後台的 Environment Variables)
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

// 2. 初始化 LINE Client 與 Express 伺服器
const client = new line.Client(config);
const app = express();

// 3. 建立 Webhook 路由 (LINE 伺服器會把訊息推送到這裡)
app.post('/webhook', line.middleware(config), (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error('Webhook 發生錯誤:', err);
      res.status(500).end();
    });
});

// 4. 處理各種事件的核心邏輯
async function handleEvent(event) {
  
  // ==========================================
  // 功能 A：有人加入群組時，自動 @標記真實名字 並發送群規
  // ==========================================
  if (event.type === 'memberJoined') {
    // 取得剛加入的第一位成員 UserID
    const joinedUserId = event.joined.members[0].userId;
    let userName = '新成員'; // 預設名稱 (防呆機制)

    // 🌟 安全機制：嘗試向 LINE 伺服器索取這位新成員的真實暱稱
    try {
      // 確保事件發生在群組中，才使用群組專用的 API 抓取名字
      if (event.source.type === 'group') {
        const profile = await client.getGroupMemberProfile(event.source.groupId, joinedUserId);
        userName = profile.displayName; 
      }
    } catch (error) {
      console.log('無法抓取新成員名稱，將使用預設名稱 @新成員');
    }
    
    // 設定你的完整群規文字 (使用反引號 ` 包住以支援多行)
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

    // 🌟 組合標記文字（@加上他的真實暱稱 或 預設的新成員）
    const mentionText = `@${userName}`;
    
    // 組合最終要發送的訊息字串：標記文字 + 空兩行 + 群規
    const replyText = `${mentionText}\n\n${ruleText}`;

    // 建立帶有 @標記 (Mentions) 的訊息物件
    const welcomeMessage = {
      type: 'text',
      text: replyText,
      mentions: {
        mentionees: [
          {
            index: 0,                       // 從第 0 個字元開始標記
            length: mentionText.length,     // 動態計算「@ + 名字」的總字數長度
            type: 'user',
            userId: joinedUserId            // 填入新成員的 UserID
          }
        ]
      }
    };

    // 透過 replyToken 將訊息回覆至群組
    return client.replyMessage(event.replyToken, welcomeMessage);
  }

  // ==========================================
  // 功能 B：有人離開或被踢出群組時的紀錄
  // ==========================================
  if (event.type === 'memberLeft') {
    console.log('有成員離開或被踢出群組了');
    // 這裡通常只做紀錄，因為 LINE 官方 API 無法直接得知是誰踢的
  }

  // ==========================================
  // 其他事件 (如一般文字聊天)：不處理，直接略過
  // ==========================================
  return Promise.resolve(null);
}

// 5. 啟動伺服器
// 如果 Render 有指定 PORT 就用 Render 的，否則預設使用 3000
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🤖 機器人伺服器已啟動，正在監聽通訊埠：${PORT}`);
});
