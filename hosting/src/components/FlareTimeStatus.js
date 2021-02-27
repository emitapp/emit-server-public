import React from 'react';
import CountdownComponent from 'components/CountdownComponent';

/**
 * Displays the time status of a flare (starts in..., ongoing, ends in ...)
 */
export default class FlareTimeStatus extends React.PureComponent {
  static defaultProps = {
    diameter: 10
  }

  render() {
    const { item } = this.props
    return (
      <div>
        {item.startingTime > Date.now() &&
          <>
            <CountdownComponent
              deadLine={item.startingTime}
              renderer={this.startingTimeRenderer} />
            {this.durationRenderer(CountdownComponent.secondsToTime(item.duration / 1000))}
          </>
        }

        {item.startingTime < Date.now() &&
          <>
            <p style={{ fontSize: 18, color: "forestgreen" }}>Ongoing</p>
            <CountdownComponent
              deadLine={item.deathTimestamp}
              renderer={this.deathTimeRenderer} />
          </>
        }
      </div>
    )
  }

  startingTimeRenderer = (time) => {
    let string = "in "
    string += time.h ? `${time.h} hrs, ` : ""
    string += time.m ? `${time.m} mins ` : ""
    return (
      <div>
        <p>
          {string}
        </p>
      </div>
    );
  }

  deathTimeRenderer = (time) => {
    let string = ""
    string += time.h ? `${time.h} hrs, ` : ""
    string += time.m ? `${time.m} mins` : ""
    string += " left"
    return (
      <div>
        <p>
          {string}
        </p>
      </div>
    );
  }

  durationRenderer = (time) => {
    let string = "for "
    string += time.h ? `${time.h} hrs, ` : ""
    string += time.m ? `${time.m} mins` : ""
    return (
      <div>
        <p>
          {string}
        </p>
      </div>
    );
  }
}

