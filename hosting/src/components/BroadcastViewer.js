import ErrorMessageText from 'components/ErrorMessageText';
import FlareTimeStatus from 'components/FlareTimeStatus';
import {FlameAnimation} from 'components/Animations';
import ProfilePicDisplayer from 'components/ProfilePicComponents';
import firebase from "firebase/app";
import React from 'react';

export default class BroadcastViewer extends React.Component {

  constructor(props) {
    super(props);
    this.state = {
      attendees: [],
      errorMessage: null,
      broadcastData: this.props.broadcastSnippet,
      isModalVisible: false,
      showConfirmed: false
    }

    this.broadcastSnippet = this.props.broadcastSnippet
  }

  componentDidMount = () => {

    // firebase.database()
    //   .ref(`/activeBroadcasts/${this.broadcastSnippet.owner.uid}/responders/${this.broadcastSnippet.uid}`)
    //   .on('value', snap => this.updateAttendees(snap.val()))
  }

  componentWillUnmount = () => {
    firebase.database()
      .ref(`activeBroadcasts/${this.broadcastSnippet.owner.uid}/public/${this.broadcastSnippet.uid}`)
      .off()

    firebase.database()
      .ref(`/activeBroadcasts/${this.broadcastSnippet.owner.uid}/responders/${this.broadcastSnippet.uid}`)
      .off()
  }

  render() {
    const { broadcastData } = this.state

    return (
      <div style={{
        flex: 1, justifyContent: 'flex-start', alignItems: 'center',
        paddingTop: 8, marginHorizontal: 16
      }}>

        <ErrorMessageText message={this.state.errorMessage} />
        {!broadcastData && <FlameAnimation />}

        {broadcastData &&
          <div style={{ width: "100%" }}>

            <div style={{ alignItems: "center", marginBottom: 25, marginTop: 25 }}>
              <div style={{ flexDirection: "row" }}>
                <div style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", marginTop: -16, marginBottom: 8, marginRight: 8 }}>
                  <p style={{ fontSize: 36 }}>{broadcastData.emoji}</p>
                  <p style={{ fontSize: 24 }}>{broadcastData.activity}</p>
                </div>
                <p style={{ fontSize: 32, marginBottom: 8 }}>{broadcastData.location}</p>
              </div>
              <div style={{ flexDirection: "row", alignItems: "center", justifyContent: "center" }}>
                <div style={{ justifyContent: "center" }}>
                  <ProfilePicDisplayer diameter={32} uid={this.broadcastSnippet.owner.uid} />
                </div>
                <p style={{ marginLeft: 4, marginBottom: 8, color: "#3F83F9" }}>{this.broadcastSnippet.owner.displayName}</p>
              </div>

              <FlareTimeStatus item={broadcastData} />

            </div>

            {broadcastData.location !== undefined &&
              <div>
                <p style={{ fontSize: 24, marginLeft: 4, color: "grey", marginBottom: 8 }}>Location</p>
                <p style={{ fontSize: 18, marginLeft: 4 }}>{broadcastData.location}</p>
                <div style={{ flexDirection: "row", alignItems: "center" }}>
                  {broadcastData.geolocation &&
                    <button onPress={this.openLocationOnMap}>
                      Geolocation
                    </button>
                  }
                </div>
              </div>
            }

            {broadcastData.note !== undefined &&
              <div>
                <p style={{ marginTop: 8, fontSize: 24, marginLeft: 4, color: "grey" }}>
                  Note
                </p>
                <p>{broadcastData.note}</p>
              </div>
            }
          </div>
        }

        {(broadcastData && broadcastData.locked) &&
          <p>This broadcast has reached the response limit it's creator set. It won't receive any more responses.</p>
        }

        {/* {broadcastData &&
          <div >
            <p style={{ marginTop: 8, fontSize: 24, marginLeft: 4, marginBottom: 4, color: "grey" }}>
              Who's In
            </p>
            <p style={{ alignSelf: "center", marginLeft: 4, marginBottom: 4 }}>{broadcastData.totalConfirmations} user(s) are in!</p>
            <div style={{ height: 36 }}>
              {this.state.attendees.length > 0 &&
                <ProfilePicList
                  uids={this.state.attendees}
                  diameter={36}
                  style={{ marginLeft: 0, marginRight: 2 }} />}
            </div>
          </div>
        } */}

      </div>
    )
  }

  /**
   * Method to update the list of attendees with
   * whatever data comes from the database call
   * @param {*} data, a dictionary, the result of snapshot.val()
   */
  // updateAttendees = (data) => {
  //   var attendeesNew = []
  //   for (var id in data) {
  //     attendeesNew.push(id)
  //   }
  //   this.setState({ attendees: attendeesNew })
  // }

  openLocationOnMap = () => {
    let geolocation = this.state.broadcastData.geolocation
    window.open(`http://maps.apple.com/?ll=${geolocation.latitude},${geolocation.longitude}`)
  }
}