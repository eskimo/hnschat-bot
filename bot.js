const { subtle } = require('crypto').webcrypto;

const xml2js = require('xml2js');

const http = require("https");
const WebSocket = require("ws");
const { session, domain, keys, conversation, trigger } = require("./config.json");

var socket;
var users,conversations;

var started = [];

const channelPrice = 50;
var channelQuestions = [
	{ 
		param: "name",
		question: "What do you want the channel to be called?\n\nChannels can contain lowercase letters, numbers, and hyphens, but can't start or end with a hyphen.",
		pattern: "^[a-z0-9-]+$"
	},
	{ 
		param: "public",
		question: `Private channels can only be accessed by SLD's on a TLD that matches the channel name. For example, a private channel named "example" would only be accesible by names such as "an.example" or "another.example"\n\nShould this channel be private or public?`,
		answers: ["private", "public"]
	},
	{ 
		param: "tldadmin",
		question: "You will be given admin privledges on this channel.\n\nDo you own the TLD that matches this channel name and/or want to give admin access to whoever does?",
		answers: ["no", "yes"]
	}
];

var channelCreation = [];

getUsers().then(r => {
	users = r.users;

	getConversations().then(r => {
		conversations = r.conversations;

		let pms = 0;
		Object.keys(conversations).forEach(c => {
			if (!conversations[c].group) {
				pms += 1;
			}
		});

		let ready = 0;
		Object.keys(conversations).forEach(c => {
			makeSecretIfNeeded(c).then(d => {
				if (!conversations[c].group) {
					ready += 1;
				}

				if (ready == pms) {
					setupWebSocket();
				}
			});
		});
	});
});

function log(m) {
	console.log(m);
}

function setupWebSocket() {
	if (!socket) {
		socket = new WebSocket("wss://ws.hns.chat");

		socket.onopen = e => {
			socket.send("IDENTIFY "+session);
		};

		socket.onmessage = e => {
			parse(e);
		};

		socket.onclose = e => {
			socket = false;

			setTimeout(() => { 
				setupWebSocket();
			}, 1000);
		};

		socket.onerror = e => {}
	}
}

function isGroup(id) {
	try {
		if (conversations[id].group) {
			return true;
		}
	}
	catch (error) {}
	return false;
}

async function messageBody(message) {
	return await new Promise(function(resolve){
		if (isGroup(message.conversation)) {
			resolve(message.message);
		}
		else {
			let dkey = conversations[message.conversation].key;
			decryptMessage(message.message, dkey, message.conversation).then(function(decoded){
				resolve(decoded);
			});
		}
	});
}

function capitalize(str) {
	return str.charAt(0).toUpperCase() + str.slice(1);
}

function parse(e) {
	const message = e.data;
	const split = message.match(/(?<command>[A-Z]+)\s(?<body>.+)/);
	const command = split.groups.command;
	const body = JSON.parse(split.groups.body);

	switch (command) {
		case "MESSAGE":
			if (body.user === domain) return;
			
			if (conversation && body.conversation !== conversation) return;
			
			if (Object.keys(conversations).includes(body.conversation)) {
				messageBody(body).then(decoded => {
					if (decoded[0] === trigger) {
						handleCommand(body, decoded);
					}
					else {
						if (!isGroup(body.conversation)) {
							if (typeof channelCreation[body.user] !== "undefined") {
								let q = channelQuestions[channelCreation[body.user].question];

								if (q) {
									if (q.pattern) {
										const regex = new RegExp(q.pattern);
										if (regex.test(decoded)) {
											channelCreation[body.user].question += 1;
											channelCreation[body.user][q.param] = decoded;
										}
									}
									else if (q.answers) {
										if (q.answers.includes(decoded.toLowerCase())) {
											channelCreation[body.user].question += 1;

											let index = q.answers.indexOf(decoded.toLowerCase());
											channelCreation[body.user][q.param] = index;
										}
									}

									if (channelCreation[body.user].question > channelQuestions.length - 1) {
										let data = channelCreation[body.user];
										data.action = "createChannel";
										data.user = body.user;
										delete data.question;
										
										api(data).then(r => {
											if (r.success) {
												reply(body, `That's it! Just send a payment of ${r.fee} HNS to complete your registration.\n\nIt will take roughly 30 minutes to confirm and for the channel to appear.`);
												channelCreation[body.user]["id"] = r.id;
											}
											else {
												reply(body, `${r.message} Type ${trigger}channel to start over.`);
											}
										});
									}
									else {
										let nextQ = channelQuestions[channelCreation[body.user].question];
										let question = channelQuestions[channelCreation[body.user].question].question;

										if (nextQ.answers) {
											let answers = `[${nextQ.answers.map(capitalize).join("/")}]`;

											question += "\n\n"+answers;
										}
										reply(body, question);
									}
								}
								else {
									try {
										let json = JSON.parse(decoded);

										if (json.hnschat) {
											let id = channelCreation[body.user].id;
											let tx = json.payment;
											let amount = json.amount;

											let data = {
												action: "receivedPayment",
												channel: id,
												tx: tx,
												amount: amount
											};

											api(data).then(r => {
												if (r.success) {
													reply(body, `You're all set! Your channel should be live within 30 minutes.`);
													delete channelCreation[body.user];
												}
												else {
													reply(body, `${r.message}`);
												}
											});
										}
									}
									catch {}
								}
							}
						}
					}
				});
			}
			break;

		case "CONVERSATION":
			createConversation(body).then(() => {
				for (s in started) {
					if (Object.keys(body.users).includes(started[s].from)) {
						sendMessage(body.id, started[s].message);
						delete started[s];
					}
				}
			});
			break;
	}
}

function handleCommand(msg, message) {
	let split = message.split(" ");
	const command = split[0].substring(1);
	split.shift();
	const params = split;

	switch (command) {
		case "hns":
			fetchData({
				host: "api.coingecko.com",
				path: "/api/v3/simple/price?ids=handshake&vs_currencies=usd",
			}).then(response => {
				if (response) {
					const data = JSON.parse(response);
					let price = data.handshake.usd;

					if (params.length) {
						let input = params[0].replace(/[^\$0-9\.]/g, '');
						if (input[0] === "$") {
							input = input.substring(1);
							reply(msg, `${(input / price).toLocaleString("en-US")} HNS`);
						}
						else {
							reply(msg, `$${(price * input).toLocaleString("en-US")}`);
						}
					}
					else {
						reply(msg, `$${price.toLocaleString("en-US")}`);
					}
				}
			});
			break;

		case "theshake":
			fetchData({
				host: "theshake.substack.com", 
				path: "/feed"
			}).then(response => {
				if (response) {	
					parseXML(response).then(data => {
						const { link } = data.rss.channel[0].item[0];;
						reply(msg, `${link}`);
					});
				}
			});
			break;

		case "channel":
			if (isGroup(msg.conversation)) {
				const data = {
					action: "startConversation",
					from: domain,
					to: nameForUserID(msg.user).domain,
					message: `Creating a channel only takes a minute. You'll need to answer a few questions and then send a payment of ${channelPrice} HNS to complete the process. Type ${trigger}channel to get started.`
				};

				started[data.to] = data;

				ws("ACTION", data);

				reply(msg, `I've sent you a PM with more information on creating a channel.`, true);
			}
			else {
				channelCreation[msg.user] = {
					question: 0
				}
				reply(msg, channelQuestions[channelCreation[msg.user].question].question);
			}
			break;
		
		default: break;
	}

}

function sendMessage(message, string, reply=false) {
	let conv = message.conversation || message;

	const dkey = conversations[conv].key || null;
	encryptIfNeeded(conv, string, dkey).then(function(m){
		let data = {
			action: "sendMessage",
			conversation: conv,
			from: domain,
			message: m
		};

		if (reply) {
			data.replying = message.id;
		}

		ws("ACTION", data);
	});
}

function reply(message, string, reply=false) {
	sendMessage(message, string, reply);
}

async function parseXML(data) {
	const parser = new xml2js.Parser();
	return await new Promise(resolve => {
		parser.parseStringPromise(data).then(result => {
			resolve(result);				
		}).catch(err => {
			resolve();
		});
	});
};

async function encryptIfNeeded(conversation, message, dkey) {
	return await new Promise(resolve => {
		if (dkey) {
			encryptMessage(message, dkey, conversation).then(function(m){
				resolve(m);
			});
		}
		else {
			resolve(message);
		}
	});
}

function ws(command, body) {
	socket.send(command+" "+JSON.stringify(body));
}

async function fetchData(options) {
	return await new Promise(resolve => {
		http.get(options, r => {
			let data = '';
			
			r.on('data', chunk => {
				data += chunk;
			});
			r.on('end', () => {
				resolve(data);
			});
		}).on('error', e => {
			resolve();
		});
	});
}


async function api(data) {
	if (session) {
		data["key"] = session;
	}

	return await new Promise(resolve => {
		data = JSON.stringify(data);

		const options = {
			host: "hns.chat",
			path: "/api",
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
		        'Content-Length': Buffer.byteLength(data)
			}
		}

		const req = http.request(options, r => {
			let response = '';
			r.on('data', chunk => {
				response += chunk;
			});
			r.on('end', () => {
				const json = JSON.parse(response);
				resolve(json);
			});
		}).on('error', e => {
			resolve();
		});

		req.write(data);
		req.end();
	});
}

async function makeSecretIfNeeded(c) {
	return await new Promise(resolve => {
		if (!conversations[c].group) {
			makeSecret(c).then(r => {
				resolve();
			});
		}
		else {
			resolve();
		}
	});
}

async function makeSecret(k) {
	let derivedKey = new Promise(resolve => {
		let otherUser = getOtherUser(k);
		let otherKey = JSON.parse(otherUser.pubkey);

		if (otherKey) {
			deriveKey(otherKey, keys.privateKeyJwk).then(d => {
				conversations[k].key = d;
				resolve(d);
			});
		}
		else {
			resolve();
		}
	}); 

	return await derivedKey;
}

function getOtherUser(id) {
	const c = conversations[id];

	const user = Object.keys(c.users)
	 .filter(u => u !== domain)
	 .join(", ");

	return c.users[user];
}

function nameForUserID(id) {
	let user = users.filter(user => {
		return user.id == id;
	});

	return user[0];
}

function getUsers() {
	const data = {
		action: "getUsers"
	};

	return api(data);
}

function getConversations() {
	const data = {
		action: "getConversations",
		domain: domain
	};

	return api(data);
}

async function createConversation(conversation) {
	conversations[conversation.id] = conversation;
	
	let output = new Promise(resolve => {
		let name = getOtherUser(conversation.id);
		if (name) {
			makeSecret(conversation.id).then(() => {
				resolve();
			});
		}
		else {
			resolve();
		}
	})

	return await output;
}

async function deriveKey(publicKeyJwk, privateKeyJwk) {
  const publicKey = await subtle.importKey(
    "jwk",
    publicKeyJwk,
    {
      name: "ECDH",
      namedCurve: "P-256",
    },
    true,
    []
  );

  const privateKey = await subtle.importKey(
    "jwk",
    privateKeyJwk,
    {
      name: "ECDH",
      namedCurve: "P-256",
    },
    true,
    ["deriveKey", "deriveBits"]
  );

  return await subtle.deriveKey(
    { name: "ECDH", public: publicKey },
    privateKey,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
};

async function encryptMessage(text, derivedKey, conversation) {
  const encodedText = new TextEncoder().encode(text);

  const encryptedData = await subtle.encrypt(
    { name: "AES-GCM", iv: new TextEncoder().encode(conversation) },
    derivedKey,
    encodedText
  );

  const uintArray = new Uint8Array(encryptedData);

  const string = String.fromCharCode.apply(null, uintArray);

  const base64Data = btoa(string);

  return base64Data;
};

async function decryptMessage(text, derivedKey, conversation) {
  try {
    const initializationVector = new Uint8Array(new TextEncoder().encode(conversation)).buffer;

    const string = atob(text);
    const uintArray = new Uint8Array(
      [...string].map((char) => char.charCodeAt(0))
    );
    const algorithm = {
      name: "AES-GCM",
      iv: initializationVector,
    };
    const decryptedData = await subtle.decrypt(
      algorithm,
      derivedKey,
      uintArray
    );

    return new TextDecoder().decode(decryptedData);
  } catch (e) {
    return text;
  }
};