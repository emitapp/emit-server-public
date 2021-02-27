import { PureComponent } from "react"


/**
 * Standard error text. Defualts to null if the message is falsey (ie "", null or undefined)
 */
export default class ErrorMessageText extends PureComponent {
	static defaultStyle = { color: "red", alignSelf: "center" }
	render() {
		const { message, ...otherProps } = this.props
		if (!message) return null
		return (
			<p
				style={{ ...ErrorMessageText.defaultStyle, ...this.props.style }}
				{...otherProps}>
				{this.props.message}
			</p>
		)
	}
}