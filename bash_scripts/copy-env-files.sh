# Expected pwd: project root
echo "🤖    Copying over service account auth files for cloud functions"
cp .env/slack-sheets-credentials.json functions/src/res/slack-sheets-credentials.json