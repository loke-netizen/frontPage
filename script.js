document.getElementById('emergency-request').addEventListener('submit', function(event) {
    event.preventDefault();
    const description = document.getElementById('description').value;
    const helpList = document.getElementById('help-list');

    const listItem = document.createElement('li');
    listItem.textContent = description;
    helpList.appendChild(listItem);

    document.getElementById('description').value = ''; // Clear the input field
});
