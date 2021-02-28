import { PureComponent } from "react"

export class FlameAnimation extends PureComponent {
    //https://lottiefiles.com/16773-fire
    render() {
        return (
            <lottie-player
                src="https://assets5.lottiefiles.com/packages/lf20_D8tJsf.json"
                background="transparent"
                speed="1"
                style={{ width: 300, height: 300, ...this.props.style }}
                loop autoplay />

        )
    }
}


export class LochnessAnimation extends PureComponent {
    //https://www.pixeltrue.com/result?search=Lochness
    //https://lottiefiles.com/share/2uqzwgsp
    render() {
        return (
            <lottie-player
                src="https://assets3.lottiefiles.com/packages/lf20_2uqzwgsp.json"
                background="transparent"
                speed="1"
                style={{ width: 300, height: 300, ...this.props.styles }}
                loop autoplay />

        )
    }
}