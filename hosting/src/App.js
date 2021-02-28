import BroadcastViewer from 'components/BroadcastViewer';
import ErrorText from 'components/ErrorMessageText';
import { FlameAnimation, LochnessAnimation } from 'components/LoadingAnimations';
import "firebase/analytics";
import firebase from "firebase/app";
import "firebase/database";
import { Component } from "react";
import { logError } from 'utils/helpers';
import './App.css';
import firebaseConfig from './firebaseconfig.js';
import Logo from 'media/LogoWhite.png';
import AppStoreBadge from 'media/AppStoreBadge.svg';

class App extends Component {

  state = {
    snippet: null,
    loading: true,
    errorMessage: ""
  }

  componentDidMount() {
    if (firebase.apps.length === 0) {
      firebase.initializeApp(firebaseConfig);
      firebase.analytics()

      firebase.database().ref('activeBroadcasts/pZRvXjG3V3alrgpGMrZpnCYzcKP2/public/-MUWPnlaWdlQsu3L_8PW').get()
        .then(s => {
          this.setState({ loading: false })
          if (s.exists()) this.setState({ snippet: { ...s.val(), uid: s.key } })
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
          <a href="https://getemit.com/" target="_blank" rel="noreferrer">
            <img
              style={{ height: 50, marginRight: 24, marginLeft: 24 }}
              src={Logo}
              alt="Emit Logo"
            />
          </a>
          <a href="https://getemit.com/"
            style={{ color: "inherit", textDecoration: "inherit" }}
            target="_blank"
            rel="noreferrer">
            <p> Emit </p>
          </a>
        </header>

        <div className="content">
          <ErrorText message={this.state.errorMessage} />
          {this.state.loading && this.renderLoadingComponent()}
          {(!this.state.loading && !this.state.snippet) && this.renderNoFlareComponent()}
          {this.state.snippet && <BroadcastViewer broadcastSnippet={this.state.snippet} />}
        </div>

        <footer class="footer">
          <p> Download Emit for free and make your own flares! </p>
          <a href="https://apps.apple.com/app/id1553654500" target="_blank" rel="noreferrer">
            <img
              style={{ height: 40, marginRight: 24, marginLeft: 24 }}
              src={AppStoreBadge}
              alt="Emit Logo"
            />
          </a>
        </footer>
      </div>
    )
  }

  renderLoadingComponent = () => {
    return (
      <div
        style={{
          flex: 1, width: "100%", alignItems: "center",
          justifyContent: "center", display: "flex", flexDirection: "column"
        }}>
        <FlameAnimation />
        <p>Fetting your flare! Hang tight.</p>
      </div>
    )
  }


  renderNoFlareComponent = () => {
    return (
      <div
        style={{
          flex: 1, width: "100%", alignItems: "center",
          justifyContent: "center", display: "flex", flexDirection: "column"
        }}>
        <LochnessAnimation />
        <p>Looks like this flare is over, or maybe it never existed in the first place!</p>
      </div>
    )
  }
}

export default App;
