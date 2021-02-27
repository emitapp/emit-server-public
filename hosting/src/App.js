import BroadcastViewer from 'components/BroadcastViewer';
import ErrorText from 'components/ErrorMessageText';
import LoadingAnim from 'components/LoadingAnim';
import "firebase/analytics";
import firebase from "firebase/app";
import "firebase/database";
import { Component } from "react";
import { logError } from 'utils/helpers';
import './App.css';
import firebaseConfig from './firebaseconfig.js';


class App extends Component {

  state = {
    snippet: null,
    errorMessage: ""
  }

  componentDidMount() {
    if (firebase.apps.length === 0) {
      firebase.initializeApp(firebaseConfig);
      firebase.analytics()

      firebase.database().ref('activeBroadcasts/pZRvXjG3V3alrgpGMrZpnCYzcKP2/public/-MUWPnlaWdlQsu3L_8PW').get()
        .then(s => {
          this.setState({ snippet: {...s.val(), uid: s.key }})
        })
        .catch(e => {
          this.setState({ errorMessage: e.message })
          logError(e)
        })
    }
  }

  render() {
    return (
      <div className="App">
        <header className="App-header">
          <p> Emit </p>
        </header>

        <ErrorText message={this.state.errorMessage} />
        {!this.state.snippet && <LoadingAnim />}
        {this.state.snippet && <BroadcastViewer broadcastSnippet={this.state.snippet} />}

      </div>
    )
  }
}

export default App;
