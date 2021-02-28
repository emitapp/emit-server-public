import { Component } from "react";
import { Route, Switch } from "react-router-dom";
import './App.css';
import FlareFinder from './FlareFinder';

class App extends Component {

  render() {
    return (
      <div className="App">
        <Switch>
          <Route path="/:flareSlug" component={FlareFinder} />
          <Route path="/" component={FlareFinder} />
        </Switch>
      </div>
    )
  }
}

export default App;
