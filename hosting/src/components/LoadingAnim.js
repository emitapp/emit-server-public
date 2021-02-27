import { PureComponent } from "react"
import ReactLoading from 'react-loading';

class LoadingAnim extends PureComponent {

    render() {
        return (
            <ReactLoading type="cylon" color="orange" height={667} width={375} />
        )
    }
}

export default LoadingAnim;