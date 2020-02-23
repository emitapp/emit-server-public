import * as functions from 'firebase-functions';
import admin = require('firebase-admin');

export const updateMaskMemberCount = functions.database.ref('/userFriendGroupings/{userUid}/custom/details/{maskUid}/memberUids')
    .onWrite(async (snapshot, context) => {
      const newValue = snapshot.after.val()
      const database = admin.database()
      const snippetRef = database.ref(`/userFriendGroupings/${context.params.userUid}/custom/snippets/${context.params.maskUid}`)

    //If this has been deleted, either the mask has no people in it or it's been deleted
      if (newValue === null){ 
        const snippetSnapshot = await snippetRef.once("value")
        if (!snippetSnapshot.exists()) return; //The mask itself has been deleted
        else await snippetRef.child("memberCount").set(0)
      }else{
        await snippetRef.child("memberCount").set(Object.keys(newValue).length)
      }
    });