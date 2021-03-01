import "firebase/analytics";
import "firebase/database";
import BroadcastViewer from 'components/BroadcastViewer';
import ErrorText from 'components/ErrorMessageText';
import { FlameAnimation, LochnessAnimation, SearchingAnimation } from 'components/Animations';
import "firebase/analytics";
import firebase from "firebase/app";
import "firebase/database";
import AppStoreBadge from 'media/AppStoreBadge.svg';
import Logo from 'media/LogoWhite.png';
import { Component } from "react";
import './App.css';
import firebaseConfig from './firebaseconfig.js';
import { logError } from 'utils/helpers'

class FlareFinder extends Component {

    constructor(props) {
        super(props)

        this.flareSlug = props.match.params.flareSlug
        if (this.flareSlug) this.flareSlug = this.flareSlug.toLowerCase()

        this.state = {
            snippet: null,
            loading: true,
            errorMessage: "",
            formInput: ""
        }
    }


    componentDidMount() {
        if (firebase.apps.length === 0) {
            firebase.initializeApp(firebaseConfig);
            firebase.analytics()
        }
        this.getInitalData()
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

                {this.renderForm()}
                {this.renderMainContent()}

                <footer className="footer">
                    <p style={{ alignSelf: "flex-end", color: "lightgray", fontSize: 12, marginRight: 8 }}>
                        Animations by <a href="https://lottiefiles.com/28795-camp-guy">romixi</a>,{" "}
                        <a href="https://lottiefiles.com/16773-fire">白寒</a> and {" "}
                        <a href="https://lottiefiles.com/share/2uqzwgsp">pixeltrue.</a>
                    </p>
                    <div className="footer-main-content">
                        <p> Download Emit for free and make your own flares! </p>
                        <a href="https://apps.apple.com/app/id1553654500" target="_blank" rel="noreferrer">
                            <img
                                style={{ height: 40, marginRight: 24, marginLeft: 24 }}
                                src={AppStoreBadge}
                                alt="Emit Logo"
                            />
                        </a>
                    </div>

                </footer>
            </div>
        )
    }

    getInitalData = async () => {
        if (!this.flareSlug) return
        try {
            let flareInfo = await firebase.database().ref(`flareSlugs/${this.flareSlug}`).get()
            if (!flareInfo.exists()) {
                this.setState({ loading: false })
                return
            }

            flareInfo = flareInfo.val()
            const flare = await firebase.database().ref(`activeBroadcasts/${flareInfo.ownerUid}/public/${flareInfo.flareUid}`).get()
            this.setState({ snippet: { ...flare.val(), uid: flareInfo.flareUid }, loading: false })
        } catch (e) {
            this.setState({ errorMessage: e.message })
            logError(e)
        }
    }

    renderMainContent = () => {
        if (!this.flareSlug) return null;
        return (
            <div className="content">
                <ErrorText message={this.state.errorMessage} />
                {this.state.loading && this.renderLoadingComponent()}
                {(!this.state.loading && !this.state.snippet) && this.renderNoFlareComponent()}
                {this.state.snippet && <BroadcastViewer broadcastSnippet={this.state.snippet} />}
            </div>
        )
    }

    renderForm = () => {
        if (this.flareSlug) return null;
        return (
            <div className="content">
                <div style={{
                    flex: 1, width: "100%", alignItems: "center",
                    justifyContent: "center", display: "flex", flexDirection: "column"
                }}>
                    <SearchingAnimation />
                    <form onSubmit={this.handleSubmit} style={{ width: "80%", display: "flex", flexDirection: "column" }}>
                        <label style={{ width: "100%" }}>
                            <p> Enter Flare Code </p>
                            <br />
                            <input type="text" value={this.state.formInput} onChange={this.onFormTextChange} className="textinput" />
                        </label>
                        <input type="submit" value="Go" className="button" style={{ margin: 16, width: "fit-content", alignSelf: "center" }} />
                    </form>

                </div>
            </div>
        )
    }

    onFormTextChange = (e) => {
        this.setState({ formInput: e.target.value })
    }

    handleSubmit = () => {
        const strippedString = this.state.formInput.replace(/\s+/g, '').toLowerCase()
        if (strippedString) this.props.history.push(`/${strippedString}`)
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
                <form onSubmit={this.handleSubmit} style={{ width: "80%", display: "flex", flexDirection: "column" }}>
                    <label style={{ width: "100%" }}>
                        <input type="text" value={this.state.formInput} onChange={this.onFormTextChange} className="textinput" placeholder="Flare Code" />
                    </label>
                    <input type="submit" value="Look for Another Flare" className="button" style={{ margin: 16, width: "fit-content", alignSelf: "center" }} />
                </form>
            </div>
        )
    }
}

export default FlareFinder;
