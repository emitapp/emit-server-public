import React from 'react';

//Required Props:
//deadLine : number
//renderer: ({h: number, m: number, s: number}) -> Component
export default class CountdownComponent extends React.Component {
    constructor(props) {
      super(props);
      var milliDifference = props.deadLine - Date.now()
      this.state = { time: {}, secondsLeft: milliDifference / 1000};
      this.timerID = 0;
    }
  
    componentDidMount() {
      let timeLeftVar = CountdownComponent.secondsToTime(this.state.secondsLeft);
      this.setState({ time: timeLeftVar });
      this.startTimer()
    }
  
    componentWillUnmount(){
      clearInterval(this.timerID)
    }
  
    startTimer = () => {
      if (this.timerID === 0 && this.state.secondsLeft > 0) {
        this.timerID = setInterval(this.countDown, 1000); //Do it every second
      }
    }
  
    countDown = () => {
      // Remove one second, set state so a re-render happens.
      let secondsLeft = this.state.secondsLeft - 1;
      this.setState({
        time: CountdownComponent.secondsToTime(secondsLeft),
        secondsLeft,
      });
      
      // Check if we're at zero.
      if (secondsLeft === 0) { 
        clearInterval(this.timerID);
      }
    }
  
    //TODO: maybe move this to utils?
    static secondsToTime(secs){
      let hours = Math.floor(secs / (60 * 60));
  
      let divisor_for_minutes = secs % (60 * 60);
      let minutes = Math.floor(divisor_for_minutes / 60);
  
      let divisor_for_seconds = divisor_for_minutes % 60;
      let seconds = Math.ceil(divisor_for_seconds);
  
      let obj = {
        "h": hours,
        "m": minutes,
        "s": seconds
      };
      return obj;
    }
  
    render() {
      return this.props.renderer(this.state.time)
    }
  }