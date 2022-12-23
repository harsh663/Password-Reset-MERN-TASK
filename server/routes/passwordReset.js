const router = require("express").Router();
const { User } = require("../models/user");
const Token = require("../models/token");
const sendEmail = require("../utils/sendEmail");
const crypto = require("crypto");
// for password complexity
const Joi = require("joi");
const passwordComplexity = require("joi-password-complexity");
// bcrypt to hash passwords and reset tokens
const bcrypt = require("bcrypt");
const amqp = require("amqplib/callback_api");

// send password link
router.post("/", async (req, res) => {
	try {
		const emailSchema = Joi.object({
			email: Joi.string().email().required().label("Email"),
		});
		console.log(req.body);
		const { error } = emailSchema.validate(req.body);
		if (error)
			return res.status(400).send({ message: error.details[0].message });

		let user = await User.findOne({ email: req.body.email });
		console.log("user >> ", user);
		if (!user)
			return res.status(409).send({ message: "User with given email does not exist!" });

		let token = await Token.findOne({ userId: user._id });
		if (!token) {
			token = await new Token({
				userId: user._id,
				token: crypto.randomBytes(32).toString("hex"),
			}).save();
		}
		const url = `${process.env.BASE_URL}password-reset/${user._id}/${token.token}/`;

		// connect to amqp cloud
		amqp.connect(process.env.RABBITMQ_URI, (err, connection) => {
			if (err)
				throw err;

			// provider
			connection.createChannel((err1, channel) => {
				if (err1)
					throw err1;

				channel.assertQueue("email3", { durable: true });
				channel.sendToQueue("email3", Buffer.from(JSON.stringify({ "email": user.email, url })));
			}, { noAck: true });

			// consumer
			connection.createChannel((err1, channel) => {
				if (err1)
					throw err1;
				// if queue is already present then use it or create a new queue
				channel.assertQueue("email3", { durable: true });
				channel.consume("email3", (msg) => {
					const parsed = JSON.parse(msg.content.toString());
					sendEmail(parsed.email, "Password Reset", parsed.url);
				});
			}, { noAck: true });

		})
		res.status(200).send({ message: "Password reset link sent to your email account" });
	} catch (error) {
		console.log(error);
		res.status(500).send({ message: "Internal Server Error" });
	}
});

// verify password reset link
router.get("/:id/:token", async (req, res) => {
	try {
		const user = await User.findOne({ _id: req.params.id });
		//if user does	not exist
		if (!user) return res.status(400).send({ message: "Invalid link" });
		//create new user
		const token = await Token.findOne({
			userId: user._id,
			token: req.params.token,
		});
		// check token availability
		if (!token) return res.status(400).send({ message: "Invalid link" });

		res.status(200).send("Valid Url");
	} catch (error) {
		res.status(500).send({ message: "Internal Server Error" });
	}
});

//  reset password
router.post("/:id/:token", async (req, res) => {
	try {
		const passwordSchema = Joi.object({
			password: passwordComplexity().required().label("Password"),
		});
		const { error } = passwordSchema.validate(req.body);
		if (error)
			return res.status(400).send({ message: error.details[0].message });

		const user = await User.findOne({ _id: req.params.id });
		if (!user) return res.status(400).send({ message: "Invalid link" });

		const token = await Token.findOne({
			userId: user._id,
			token: req.params.token,
		});
		if (!token) return res.status(400).send({ message: "Invalid link" });

		if (!user.verified) user.verified = true;

		const salt = await bcrypt.genSalt(Number(process.env.SALT));
		const hashPassword = await bcrypt.hash(req.body.password, salt);

		user.password = hashPassword;//new password
		await user.save();
		await token.remove();
		res.status(200).send({ message: "Password reset successfully" });
	} catch (error) {
		res.status(500).send({ message: "Internal Server Error" });
	}
});

//exprt router
module.exports = router;
