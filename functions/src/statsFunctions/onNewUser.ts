import { google } from 'googleapis'
import * as functions from 'firebase-functions';
import { IncomingWebhook } from "@slack/webhook"
import { join } from 'path'
import { envVariables } from '../utils/env/envVariables';

const googleAuth = new google.auth.GoogleAuth({
  keyFile: join(__dirname, '../res/slack-sheets-credentials.json'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// set auth as a global default
google.options({
  auth: googleAuth
});

const logger = functions.logger

export const notifyDevsOfNewUsers = functions.auth.user().onCreate(async (user) => {

  if (!envVariables.stats.is_prod_server) return;
  try{
    const spreadsheetId = envVariables.stats.new_users_sheets_id
    const row = [new Date(), user.email];
    const sheets = google.sheets({ version: 'v4' });
    await sheets.spreadsheets.values.append({
      spreadsheetId: spreadsheetId,
      range: "Sheet1",
      valueInputOption: 'RAW',
      requestBody: {
        majorDimension: "ROWS",
        values: [row],
        range: "Sheet1"
      }
    });

    const webhook = new IncomingWebhook(envVariables.stats.new_user_slack_webhook)
    await webhook.send({
      icon_emoji: ":calling:",
      text: `${new Date()}: ${user.email}`
    })  
  }catch(err){
    logger.error("autoDeleteBroadcast error", err)
  }
});