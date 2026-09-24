const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve the website's files (index.html, logo.png) from this same folder
app.use(express.static(path.join(__dirname)));

// Any other route also just shows the site (simple single-page setup)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Inua Jamii Loans site running on port ${PORT}`);
});
