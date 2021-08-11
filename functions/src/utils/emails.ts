import SMTPTransport = require('nodemailer/lib/smtp-transport');

//Based on A2 Hosting email configurations
//Don't use this for Gmail (https://nodemailer.com/usage/using-gmail/)
export const sendEmailFromCustomDomain = async (
    mailServer: string, 
    port: number, 
    useTLS: boolean, // true for port 465, usually false for other ports
    fromAddress: string, 
    fromAddressPassword: string,
    receiverAddress: string, 
    subject: string,
    htmlMessage: string
): Promise<void> => {
    const nodemailer = await import('nodemailer');
    const options : SMTPTransport.Options = {
        host: mailServer,
        port,
        secure: useTLS,
        auth: {
               user: fromAddress,
               pass: fromAddressPassword,
           }
    }
    const transporter = nodemailer.createTransport(options);
    
    const mailOptions = {
        from: fromAddress, 
        to: receiverAddress, 
        subject, 
        html: htmlMessage,
    };
    
    await transporter.sendMail(mailOptions)    
}
