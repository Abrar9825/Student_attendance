const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const session = require('express-session');
const xlsx = require('xlsx'); // Require the xlsx library
require('dotenv').config(); // Load environment variables from .env file

const app = express();
const port =  process.env.PORT ||7861;

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Set the view engine to EJS
app.set('view engine', 'ejs');

app.use(session({
    secret: 'yourSecretKey',
    resave: false,
    saveUninitialized: true
}));

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI);

const db = mongoose.connection;
db.on('error', console.error.bind(console, 'connection error:'));
db.once('open', () => {
    console.log('Connected to the database');
});

// Define student schema and model
const studentSchema = new mongoose.Schema({
    username: String,
    password: String
});
const Student = mongoose.model('Student', studentSchema);

// Define faculty schema and model
const facultySchema = new mongoose.Schema({
    username: String,
    password: String
});
const Faculty = mongoose.model('Faculty', facultySchema);

// Define session schema and model
const sessionSchema = new mongoose.Schema({
    facultyName: String,
    time: String,
    limit: Number,
    otp: Number,
    attendanceCount: { type: Number, default: 0 },
    attendedStudents: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Student' }],
    isActive: { type: Boolean, default: true },
    downloadLink: { type: String, default: '' },
    downloaded: { type: Boolean, default: false } // Add this field to track if the session was downloaded
});
const Session = mongoose.model('Session', sessionSchema);

// Define attendance schema and model
const attendanceSchema = new mongoose.Schema({
    studentUsername: { type: String, required: true },
    otp: { type: Number, required: true },
    time: { type: String, required: true },
    sessionTime: { type: String, required: true },
    facultyName: { type: String, required: true }
});
const Attendance = mongoose.model('Attendance', attendanceSchema);

// Route to render the landing page
app.get('/', (req, res) => {
    res.render('index');
});

// Route to render the login form
app.get('/login', (req, res) => {
    res.render('loginForm');
});

// Route to render the signup form
app.get('/signup', (req, res) => {
    res.render('signupForm');
});

// Route to render the create session page for faculty
app.get('/createSession', async (req, res) => {
    if (req.session.user && req.session.userType === 'faculty') {
        const sessions = await Session.find({ facultyName: req.session.user.username, downloaded: false });
        res.render('faculty/createSession', { sessions });
    } else {
        res.redirect('/login');
    }
});

// Route to render the view sessions page for students
app.get('/viewSessions', async (req, res) => {
    if (req.session.user && req.session.userType === 'student') {
        const sessions = await Session.find({ isActive: true });
        res.render('student/viewSessions', { sessions });
    } else {
        res.redirect('/login');
    }
});

// Route to add a student
app.post('/students', async (req, res) => {
    const newStudent = new Student(req.body);
    try {
        const savedStudent = await newStudent.save();
        res.status(201).redirect('/login');
    } catch (err) {
        res.status(400).send(err);
    }
});

// Route to add a faculty
app.post('/faculties', async (req, res) => {
    const newFaculty = new Faculty(req.body);
    try {
        const savedFaculty = await newFaculty.save();
        res.status(201).redirect('/login');
    } catch (err) {
        res.status(400).send(err);
    }
});

// Route to handle signup
app.post('/signup', async (req, res) => {
    const { username, password, userType } = req.body;

    try {
        if (userType === 'student') {
            const newStudent = new Student({ username, password });
            await newStudent.save();
        } else if (userType === 'faculty') {
            const newFaculty = new Faculty({ username, password });
            await newFaculty.save();
        }
        res.status(201).redirect('/login');
    } catch (err) {
        res.status(400).send(err);
    }
});

// Route to handle login
app.post('/login', async (req, res) => {
    try {
        const { username, password, userType } = req.body;

        if (!username || !password || !userType) {
            return res.status(400).send('Missing username, password, or userType');
        }

        let user;
        if (userType === 'student') {
            user = await Student.findOne({ username, password });
        } else if (userType === 'faculty') {
            user = await Faculty.findOne({ username, password });
        }

        if (user) {
            req.session.user = user;
            req.session.userType = userType;

            if (userType === 'faculty') {
                res.redirect('/createSession');
            } else {
                res.redirect('/viewSessions');
            }
        } else {
            res.status(401).send('Invalid credentials');
        }
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

// Route to handle session creation
app.post('/createSession', async (req, res) => {
    if (req.session.user && req.session.userType === 'faculty') {
        const { time, limit } = req.body;
        const newSession = new Session({
            facultyName: req.session.user.username,
            time,
            limit: parseInt(limit, 10),
            otp: Math.floor(1000 + Math.random() * 9000) // Generate a 4-digit OTP
        });
        await newSession.save();
        res.redirect('/createSession');
    } else {
        res.status(403).send('Unauthorized');
    }
});

app.post('/markAttendance', async (req, res) => {
    const { facultyName, time, otp } = req.body;
    const session = await Session.findOne({ facultyName, time, isActive: true });

    if (session) {
        const hasAttended = session.attendedStudents.includes(req.session.user._id);
        
        if (hasAttended) {
            return res.status(400).send('You have already marked your attendance for this session');
        }

        if (parseInt(otp, 10) === session.otp) {
            if (session.attendanceCount < session.limit) {
                session.attendanceCount += 1;
                session.attendedStudents.push(req.session.user._id);

                const attendanceRecord = new Attendance({
                    studentUsername: req.session.user.username,
                    otp: session.otp,
                    time: new Date().toISOString(),
                    sessionTime: session.time,
                    facultyName: session.facultyName
                });
                await attendanceRecord.save();

                if (session.attendanceCount >= session.limit) {
                    session.isActive = false;

                    const attendanceRecords = await Attendance.find({ sessionTime: session.time, facultyName: session.facultyName });
                    const wb = xlsx.utils.book_new();
                    const ws = xlsx.utils.json_to_sheet(attendanceRecords.map(record => ({
                        studentUsername: record.studentUsername,
                        otp: record.otp,
                        time: record.time,
                        sessionTime: record.sessionTime,
                        facultyName: record.facultyName
                    })));
                    xlsx.utils.book_append_sheet(wb, ws, 'Attendance Records');

                    const filePath = path.join(__dirname, 'public', 'downloads', `Attendance_Records_${session.time}.xlsx`);
                    xlsx.writeFile(wb, filePath);

                    session.downloadLink = `/downloads/Attendance_Records_${session.time}.xlsx`;
                    await session.save();
                } else {
                    await session.save();
                }
                return res.redirect('/login');
            } else {
                return res.status(400).send('Attendance limit reached');
            }
        } else {
            return res.status(400).send('Invalid OTP');
        }
    } else {
        return res.status(404).send('Session not found');
    }
});

// Route to download the attendance record and mark the session as downloaded
app.get('/download/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    try {
        const session = await Session.findById(sessionId);

        if (!session || !session.downloadLink) {
            return res.status(404).send('Session not found or download link is not available');
        }

        // Serve the file for download
        const filePath = path.join(__dirname, 'public', session.downloadLink);

        // Mark the session as downloaded
        session.downloaded = true;
        await session.save();

        // Delete attendance records
        await Attendance.deleteMany({ sessionTime: session.time, facultyName: session.facultyName });

        // Delete session after download
        await Session.findByIdAndDelete(sessionId);

        // Send the file for download
        res.download(filePath, (err) => {
            if (err) {
                console.error('Error downloading file:', err);
            } else {
                console.log('Session deleted after download:', session);
            }
        });

    } catch (err) {
        console.error('Error downloading file:', err);
        res.status(500).send('Server error');
    }
});

// Serve downloads directory
app.use('/downloads', express.static(path.join(__dirname, 'public', 'downloads')));

// Route to handle logout
app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            return res.redirect('/');
        }
        res.redirect('/');
    });
});

// Start the server
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
